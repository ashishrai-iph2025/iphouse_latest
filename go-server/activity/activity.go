package activity

import (
	"encoding/json"
	"net/http"

	"github.com/ip-house/iphouse-api/db"
)

func Log(loginID int64, action, pageURL, ip, ua string, meta map[string]any) {
	go func() {
		_ = ensureSchema()
		var metaJSON *string
		if meta != nil {
			b, _ := json.Marshal(meta)
			s := string(b)
			metaJSON = &s
		}
		if len(pageURL) > 500 {
			pageURL = pageURL[:500]
		}
		if len(ip) > 45 {
			ip = ip[:45]
		}
		if len(ua) > 500 {
			ua = ua[:500]
		}
		db.Exec(
			`INSERT INTO user_activity_log (user_id, page_url, action, ip_address, user_agent, metadata, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
			loginID, pageURL, action, ip, ua, metaJSON,
		)
	}()
}

func GetIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := splitComma(xff)
		if len(parts) > 0 {
			return parts[0]
		}
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return xri
	}
	return r.RemoteAddr
}

func GetUA(r *http.Request) string {
	return r.Header.Get("User-Agent")
}

func ensureSchema() error {
	_, _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS user_activity_log (
		  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
		  user_id    INT UNSIGNED NOT NULL,
		  page_url   VARCHAR(500) DEFAULT '',
		  action     VARCHAR(64)  DEFAULT 'view',
		  ip_address VARCHAR(45)  DEFAULT '',
		  user_agent VARCHAR(500) DEFAULT '',
		  metadata   TEXT         NULL DEFAULT NULL,
		  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
		  KEY idx_user_activity (user_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	if err != nil {
		return err
	}
	db.Exec(`
		CREATE TABLE IF NOT EXISTS dcp_login (
		  id        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
		  userId    INT UNSIGNED NOT NULL,
		  loginId   INT UNSIGNED DEFAULT NULL,
		  loginTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  KEY idx_userId  (userId),
		  KEY idx_loginId (loginId)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	db.Exec(`
		CREATE TABLE IF NOT EXISTS user_dashboard_access (
		  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
		  login_id       INT UNSIGNED NOT NULL,
		  user_id        INT UNSIGNED NOT NULL,
		  report_id      VARCHAR(128) NOT NULL,
		  dashboard_name VARCHAR(255) DEFAULT '',
		  workspace_id   VARCHAR(128) DEFAULT '',
		  accessed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
		  KEY idx_uda_login  (login_id),
		  KEY idx_uda_report (report_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
	return nil
}

func splitComma(s string) []string {
	var result []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == ',' {
			result = append(result, trimSpace(s[start:i]))
			start = i + 1
		}
	}
	result = append(result, trimSpace(s[start:]))
	return result
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}
