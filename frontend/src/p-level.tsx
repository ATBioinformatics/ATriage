export const pLevels: Record<string, string> = {
 P0: "生存线：立即造成重大且难以补救的损失或中断核心目标",
 P1: "战略推进：不做会显著削弱长期目标或能力积累",
 P2: "增益亮点：不损害主线，但能增加质量或差异化",
 P3: "可延后：不做损失有限，当前投入回报较低",
};
export function PBadge({level}: {level?: string}) { return <span className={`p-level ${level || "unrated"}`} title={pLevels[level || ""] || "尚未评定，可手动设置或重新获取 AI 拆解建议"}>{level || "P级待评"}</span>; }
