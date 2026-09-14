package main

import (
	"context"
	"encoding/base64"
	"errors"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

func validateSource(s *DraftSource) error {
	if s.URL != "" {
		if e := validSourceURL(s.URL); e != nil {
			return e
		}
	}
	if strings.TrimSpace(s.Name) == "" || len(s.Name) > 300 || len(s.URL) > 2000 || len(s.Parts) == 0 || len(s.Parts) > 500 {
		return errors.New("资料名称或内容无效；最多500段")
	}
	if s.Original != "" {
		b, e := base64.StdEncoding.DecodeString(s.Original)
		if e != nil || len(b) > 5<<20 || !strings.HasPrefix(string(b), "%PDF-") {
			return errors.New("原始PDF无效或超过5MB")
		}
	}
	total := 0
	s.ID = uid()
	for i := range s.Parts {
		p := &s.Parts[i]
		if strings.TrimSpace(p.Text) == "" || len(p.Text) > 6000 || len(p.Location) > 200 {
			return errors.New("资料段为空或过长")
		}
		total += len(p.Text)
		p.ID = s.ID + "-" + itoa(i+1)
	}
	if total > 600000 {
		return errors.New("提取文字超过600KB，请按部分拆分上传")
	}
	return nil
}
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	b := []byte{}
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
func publicDraftIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !ip.IsUnspecified() && !net.ParseIP("100.64.0.0").Equal(ip) && !inCIDR(ip, "100.64.0.0/10") && !inCIDR(ip, "198.18.0.0/15") && !inCIDR(ip, "192.0.0.0/24")
}
func inCIDR(ip net.IP, cidr string) bool { _, n, _ := net.ParseCIDR(cidr); return n.Contains(ip) }
func validSourceURL(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return errors.New("请使用公开HTTPS链接（不含登录信息）")
	}
	return nil
}

var sourceScripts = regexp.MustCompile(`(?is)<(script|style|noscript)\b[^>]*>.*?</(script|style|noscript)>`)
var sourceTags = regexp.MustCompile(`(?s)<[^>]+>`)

func (a *App) fetchDraftSource(w http.ResponseWriter, r *http.Request, raw string) {
	if e := validSourceURL(raw); e != nil {
		fail(w, 400, e.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()
	transport := &http.Transport{Proxy: nil, ForceAttemptHTTP2: true, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 20 * time.Second, DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(addr)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		if len(ips) == 0 {
			return nil, errors.New("无法解析公开地址")
		}
		for _, ip := range ips {
			if !publicDraftIP(ip.IP) {
				return nil, errors.New("不读取本机或内网地址")
			}
		}
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 90 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 4 {
			return errors.New("重定向过多")
		}
		return validSourceURL(req.URL.String())
	}}
	req, e := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if e != nil {
		fail(w, 400, "链接无效")
		return
	}
	req.Header.Set("User-Agent", "ATriage-source-reader/0.3")
	res, b, e := readDraftDownload(client, req)
	if e != nil {
		fail(w, 422, e.Error())
		return
	}
	if res.StatusCode != 200 {
		fail(w, 422, "公开链接未返回可读内容")
		return
	}
	if len(b) > 5<<20 {
		fail(w, 422, "资料超过5MB，请按部分拆分")
		return
	}
	if strings.HasPrefix(string(b), "%PDF-") {
		send(w, 200, map[string]string{"kind": "pdf", "data": base64.StdEncoding.EncodeToString(b), "url": res.Request.URL.String()})
		return
	}
	ct := res.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/html") && !strings.Contains(ct, "text/plain") {
		fail(w, 422, "仅支持公开HTML、纯文本和PDF")
		return
	}
	text := string(b)
	if strings.Contains(ct, "html") {
		text = html.UnescapeString(sourceTags.ReplaceAllString(sourceScripts.ReplaceAllString(text, " "), "\n"))
	}
	text = strings.Join(strings.Fields(text), " ")
	if len(text) < 30 || len(text) > 600000 {
		fail(w, 422, "页面正文为空或过长；请粘贴正文或上传PDF")
		return
	}
	send(w, 200, map[string]string{"kind": "text", "text": text, "url": res.Request.URL.String()})
}

// Retry only transport/body failures; partial documents are never returned.
func readDraftDownload(client *http.Client, req *http.Request) (*http.Response, []byte, error) {
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		if req.Context().Err() != nil {
			break
		}
		res, err := client.Do(req.Clone(req.Context()))
		if err == nil {
			b, readErr := io.ReadAll(io.LimitReader(res.Body, (5<<20)+1))
			res.Body.Close()
			if readErr == nil {
				return res, b, nil
			}
			err = readErr
		}
		last = err
	}
	if errors.Is(req.Context().Err(), context.Canceled) {
		return nil, nil, errors.New("已停止资料读取")
	}
	var networkError net.Error
	if errors.Is(req.Context().Err(), context.DeadlineExceeded) || errors.As(last, &networkError) && networkError.Timeout() {
		return nil, nil, errors.New("资料下载超时，已自动重试一次；可稍后再试或上传本地PDF")
	}
	return nil, nil, errors.New("资料连接或下载中断，已自动重试一次；可稍后再试或上传本地PDF")
}
