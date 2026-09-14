package main

func validPLevel(level string) bool {
	return level == "" || level == "P0" || level == "P1" || level == "P2" || level == "P3"
}
