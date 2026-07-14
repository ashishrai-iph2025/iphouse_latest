package email

import (
	"crypto/tls"
	_ "embed"
	"encoding/base64"
	"fmt"
	"net/smtp"
	"regexp"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
)

// logoPNG is the IP House logo (same asset as the app sidebar), embedded into
// the binary and attached inline to every email via a Content-ID, so it always
// displays without the recipient's client having to load a remote image.
//
//go:embed logo.png
var logoPNG []byte

// logoCID is referenced from the HTML as <img src="cid:iphouse-logo">.
const logoCID = "iphouse-logo"

// logoBanner is prepended to every outgoing email — a white strip with the
// centered logo above whatever the template renders.
const logoBanner = `<div style="text-align:center;padding:20px 0 16px;background:#ffffff;">` +
	`<img src="cid:` + logoCID + `" alt="IP House" width="150" style="width:150px;max-width:60%;height:auto;display:inline-block;" /></div>`

type smtpConfig struct {
	host   string
	port   int
	secure bool
	user   string
	pass   string
	from   string
}

func getDBSmtp() *smtpConfig {
	row, err := db.QueryOne(
		"SELECT email_id, email_password, smtp_host, smtp_port, smtp_secure FROM master_email_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1",
	)
	if err != nil || row == nil {
		return nil
	}
	host, _ := row["smtp_host"].(string)
	portF, _ := row["smtp_port"].(float64)
	portI, _ := row["smtp_port"].(int64)
	port := int(portF)
	if port == 0 {
		port = int(portI)
	}
	secureStr, _ := row["smtp_secure"].(string)
	secure := secureStr == "ssl" || port == 465
	emailID, _ := row["email_id"].(string)
	emailPass, _ := row["email_password"].(string)
	decUser := ipauth.DecryptMain(emailID)
	if decUser == "" {
		decUser = emailID
	}
	decPass := ipauth.DecryptMain(emailPass)
	if decPass == "" {
		decPass = emailPass
	}
	return &smtpConfig{
		host: host, port: port, secure: secure,
		user: decUser, pass: decPass, from: decUser,
	}
}

func send(to, subject, html string) error {
	var cfg *smtpConfig

	if dbCfg := getDBSmtp(); dbCfg != nil {
		cfg = dbCfg
	} else {
		cfg = &smtpConfig{
			host:   config.C.SMTPHost,
			port:   config.C.SMTPPort,
			secure: config.C.SMTPSecure,
			user:   config.C.SMTPUser,
			pass:   config.C.SMTPPass,
		}
	}
	from := config.C.SMTPFrom
	if cfg.from != "" {
		from = fmt.Sprintf("IP House <%s>", cfg.from)
	}

	// Every email carries the IP House logo at the top.
	msg := buildMessage(from, to, subject, logoBanner+html)
	addr := fmt.Sprintf("%s:%d", cfg.host, cfg.port)
	auth := smtp.PlainAuth("", cfg.user, cfg.pass, cfg.host)

	if cfg.secure || cfg.port == 465 {
		tlsCfg := &tls.Config{ServerName: cfg.host}
		conn, err := tls.Dial("tcp", addr, tlsCfg)
		if err != nil {
			return err
		}
		defer conn.Close()
		client, err := smtp.NewClient(conn, cfg.host)
		if err != nil {
			return err
		}
		defer client.Quit()
		if err := client.Auth(auth); err != nil {
			return err
		}
		if err := client.Mail(cfg.user); err != nil {
			return err
		}
		if err := client.Rcpt(to); err != nil {
			return err
		}
		w, err := client.Data()
		if err != nil {
			return err
		}
		defer w.Close()
		_, err = w.Write([]byte(msg))
		return err
	}
	return smtp.SendMail(addr, auth, cfg.user, []string{to}, []byte(msg))
}

func buildMessage(from, to, subject, html string) string {
	// When the logo is available, send a multipart/related message: the HTML
	// part plus the logo as an inline (Content-ID) image. This is what makes the
	// logo render in Gmail/Outlook without loading anything remote. If the asset
	// is somehow missing, fall back to a plain HTML message.
	if len(logoPNG) == 0 {
		return fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n%s", from, to, subject, html)
	}

	const boundary = "=_iphouse_related_boundary_9c1f"
	var b strings.Builder
	b.WriteString("From: " + from + "\r\n")
	b.WriteString("To: " + to + "\r\n")
	b.WriteString("Subject: " + subject + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/related; boundary=\"" + boundary + "\"\r\n\r\n")

	// HTML part
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(html + "\r\n")

	// Inline logo part
	b.WriteString("--" + boundary + "\r\n")
	b.WriteString("Content-Type: image/png\r\n")
	b.WriteString("Content-Transfer-Encoding: base64\r\n")
	b.WriteString("Content-ID: <" + logoCID + ">\r\n")
	b.WriteString("Content-Disposition: inline; filename=\"iphouse-logo.png\"\r\n\r\n")
	b.WriteString(wrapBase64(base64.StdEncoding.EncodeToString(logoPNG)) + "\r\n")

	b.WriteString("--" + boundary + "--\r\n")
	return b.String()
}

// wrapBase64 splits a base64 string into 76-char lines (RFC 2045).
func wrapBase64(s string) string {
	const width = 76
	var b strings.Builder
	for len(s) > width {
		b.WriteString(s[:width])
		b.WriteString("\r\n")
		s = s[width:]
	}
	b.WriteString(s)
	return b.String()
}

// renderTemplate replaces {{key}} placeholders.
func renderTemplate(tmpl string, vars map[string]string) string {
	re := regexp.MustCompile(`\{\{(\w+)\}\}`)
	return re.ReplaceAllStringFunc(tmpl, func(match string) string {
		key := re.FindStringSubmatch(match)[1]
		if v, ok := vars[key]; ok {
			return v
		}
		return ""
	})
}

func sendTemplate(eventKey, to string, vars map[string]string, fallbackSubject, fallbackHTML string) error {
	subject := fallbackSubject
	html := fallbackHTML

	row, err := db.QueryOne(
		"SELECT subject, body_html FROM dcp_email_templates WHERE event_key = ? AND is_active = 1 LIMIT 1",
		eventKey,
	)
	if err == nil && row != nil {
		if s, ok := row["subject"].(string); ok && s != "" {
			subject = renderTemplate(s, vars)
		}
		if b, ok := row["body_html"].(string); ok && b != "" {
			html = renderTemplate(b, vars)
		}
	}

	return send(to, subject, html)
}

// ── Named helpers ─────────────────────────────────────────────────────────────

func SendOTP(to, code, userName string) error {
	return sendTemplate("otp_verification", to, map[string]string{
		"otp_code": code, "user_name": userName, "expiry_minutes": "10",
	},
		"Your IP House Login Code",
		fmt.Sprintf(`<div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;"><h2 style="color:#14254A;">Email Verification</h2><p style="color:#5f768b;">Use the code below to complete your login. It expires in <strong>10 minutes</strong>.</p><div style="background:#f3f6fb;border-radius:10px;padding:24px;text-align:center;letter-spacing:10px;font-size:36px;font-weight:700;color:#14254A;">%s</div></div>`, code),
	)
}

func SendPasswordReset(to, resetToken, userName string) error {
	return sendTemplate("password_reset_token", to, map[string]string{
		"user_name": userName, "reset_token": resetToken, "expiry_time": "10 minutes",
	},
		"Reset Your IP House Password",
		fmt.Sprintf(`<div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;"><h2 style="color:#14254A;">Reset Password</h2><p style="color:#5f768b;">Hi <strong>%s</strong>, copy this token and paste it on the reset page (expires in <strong>10 minutes</strong>):</p><div style="background:#f3f6fb;border-radius:10px;padding:20px 24px;word-break:break-all;font-family:monospace;font-size:14px;font-weight:700;color:#14254A;border:1px dashed #c7d2e0;">%s</div></div>`, userName, resetToken),
	)
}

func SendRegistrationApproved(to, userName, username, password, loginURL string) error {
	return sendTemplate("registration_approved", to, map[string]string{
		"user_name": userName, "email": username, "password": password, "login_url": loginURL,
	},
		"Dashboard Access Enabled – Your IP House Credentials",
		fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;"><div style="background:#14254A;padding:24px 32px;text-align:center;"><h1 style="color:#fff;">Dashboard Access Enabled</h1></div><div style="padding:32px;"><p>Dear <strong>%s</strong>,</p><p>Your credentials: <strong>%s</strong> / <strong>%s</strong></p><p><a href="%s">%s</a></p></div></div>`, userName, username, password, loginURL, loginURL),
	)
}

// urlsListHTML renders the submitted URLs as an HTML ordered list (capped at 50).
func urlsListHTML(urls []string) string {
	if len(urls) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(`<ol style="margin:0;padding-left:20px;color:#14254A;font-size:13px;line-height:1.7;">`)
	limit := len(urls)
	if limit > 50 {
		limit = 50
	}
	for i := 0; i < limit; i++ {
		b.WriteString(fmt.Sprintf(`<li style="word-break:break-all;"><a href="%s" style="color:#0078D4;">%s</a></li>`, urls[i], urls[i]))
	}
	b.WriteString(`</ol>`)
	if len(urls) > 50 {
		b.WriteString(fmt.Sprintf(`<p style="font-size:12px;color:#5f768b;">…and %d more</p>`, len(urls)-50))
	}
	return b.String()
}

// SendInfringementClientConfirmation notifies the API-credential client email that
// a takedown batch was submitted on their account.
func SendInfringementClientConfirmation(to, name, platform, assetName, remarks string, urls []string) error {
	urlCount := fmt.Sprintf("%d", len(urls))
	remarksHTML := remarks
	if remarksHTML == "" {
		remarksHTML = "—"
	}
	return sendTemplate("infringement_client_confirmation", to, map[string]string{
		"name": name, "user_name": name, "platform": platform,
		"asset_name": assetName, "remarks": remarksHTML,
		"url_count": urlCount, "urls_list": urlsListHTML(urls),
		"date": time.Now().Format("02 Jan 2006, 15:04"),
	},
		"Infringement Submission Confirmation",
		fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><div style="background:#14254A;padding:22px 28px;"><h2 style="color:#fff;margin:0;font-size:18px;">Takedown Request Received</h2></div><div style="padding:28px;color:#14254A;"><p>Dear <strong>%s</strong>,</p><p>Your takedown request has been submitted successfully.</p><table style="width:100%%;font-size:14px;border-collapse:collapse;margin:12px 0;"><tr><td style="padding:6px 0;color:#5f768b;">Platform</td><td style="padding:6px 0;font-weight:600;">%s</td></tr><tr><td style="padding:6px 0;color:#5f768b;">Asset</td><td style="padding:6px 0;font-weight:600;">%s</td></tr><tr><td style="padding:6px 0;color:#5f768b;">URLs</td><td style="padding:6px 0;font-weight:600;">%d</td></tr></table>%s</div></div>`,
			name, platform, assetName, len(urls), urlsListHTML(urls)),
	)
}

// SendInfringementUserNotification notifies the logged-in dashboard user that
// their submission was recorded.
func SendInfringementUserNotification(to, userName, platform, assetName string, urls []string) error {
	urlCount := fmt.Sprintf("%d", len(urls))
	return sendTemplate("infringement_user_notification", to, map[string]string{
		"user_name": userName, "name": userName, "platform": platform,
		"asset_name": assetName, "url_count": urlCount,
		"urls_list": urlsListHTML(urls),
		"date":      time.Now().Format("02 Jan 2006, 15:04"),
	},
		"Your Infringement Submission Has Been Recorded",
		fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;"><div style="background:#14254A;padding:22px 28px;"><h2 style="color:#fff;margin:0;font-size:18px;">Submission Recorded</h2></div><div style="padding:28px;color:#14254A;"><p>Hi <strong>%s</strong>,</p><p>Your takedown submission has been recorded.</p><table style="width:100%%;font-size:14px;border-collapse:collapse;margin:12px 0;"><tr><td style="padding:6px 0;color:#5f768b;">Platform</td><td style="padding:6px 0;font-weight:600;">%s</td></tr><tr><td style="padding:6px 0;color:#5f768b;">Asset</td><td style="padding:6px 0;font-weight:600;">%s</td></tr><tr><td style="padding:6px 0;color:#5f768b;">URLs</td><td style="padding:6px 0;font-weight:600;">%d</td></tr></table>%s</div></div>`,
			userName, platform, assetName, len(urls), urlsListHTML(urls)),
	)
}

// SendRegistrationReceivedApplicant sends a confirmation to the person who submitted
// the registration form. Event key: registration_received_applicant.
func SendRegistrationReceivedApplicant(firstName, lastName, emailAddr, designation string) error {
	fullName := strings.TrimSpace(firstName + " " + lastName)
	if designation == "" {
		designation = "—"
	}
	return sendTemplate("registration_received_applicant", emailAddr, map[string]string{
		"first_name":  firstName,
		"last_name":   lastName,
		"full_name":   fullName,
		"email":       emailAddr,
		"designation": designation,
		"date":        time.Now().Format("02 Jan 2006, 15:04"),
	},
		"IP House - Account Registration for Analytics Report Received",
		fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
<div style="background:#14254A;padding:22px 28px;"><h2 style="color:#fff;margin:0;font-size:18px;">Registration Received</h2></div>
<div style="padding:28px;color:#14254A;">
  <p>Dear <strong>%s</strong>,</p>
  <p>Thank you for submitting your registration request for the IP House Analytics Report dashboard. We have received your request and it is currently under review.</p>
  <p>You will be notified by email once your account has been approved.</p>
  <p style="margin-top:24px;font-size:13px;color:#5f768b;">If you have any questions, please contact your IP House account manager.</p>
</div></div>`, fullName),
	)
}

// SendRegistrationReceivedAdmin notifies the admin that a new registration request was
// submitted. Recipient is read from the template's notify_email field; falls back to
// the hard-coded default. Event key: registration_received_admin.
func SendRegistrationReceivedAdmin(firstName, lastName, emailAddr, designation, remarks string) error {
	const defaultAdminEmail = "ashish.rai@ip-house.com"

	// Resolve recipient from the template's notify_email column
	to := defaultAdminEmail
	if row, err := db.QueryOne("SELECT notify_email FROM dcp_email_templates WHERE event_key = 'registration_received_admin' AND is_active = 1 LIMIT 1"); err == nil && row != nil {
		if v, ok := row["notify_email"].(string); ok && v != "" {
			to = v
		}
	}

	fullName := strings.TrimSpace(firstName + " " + lastName)
	if designation == "" {
		designation = "—"
	}
	if remarks == "" {
		remarks = "—"
	}
	return sendTemplate("registration_received_admin", to, map[string]string{
		"first_name":  firstName,
		"last_name":   lastName,
		"full_name":   fullName,
		"email":       emailAddr,
		"designation": designation,
		"remarks":     remarks,
		"date":        time.Now().Format("02 Jan 2006, 15:04"),
	},
		"Client Dashboard Account Creation Request",
		fmt.Sprintf(`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
<div style="background:#14254A;padding:22px 28px;"><h2 style="color:#fff;margin:0;font-size:18px;">Client Dashboard Account Creation Request</h2></div>
<div style="padding:28px;color:#14254A;">
  <p>A new user has submitted a registration request and is awaiting your approval.</p>
  <table style="width:100%%;font-size:14px;border-collapse:collapse;margin:16px 0;">
    <tr><td style="padding:7px 0;color:#5f768b;width:130px;">Name</td><td style="padding:7px 0;font-weight:600;">%s</td></tr>
    <tr><td style="padding:7px 0;color:#5f768b;">Email</td><td style="padding:7px 0;font-weight:600;">%s</td></tr>
    <tr><td style="padding:7px 0;color:#5f768b;">Designation</td><td style="padding:7px 0;">%s</td></tr>
    <tr><td style="padding:7px 0;color:#5f768b;">Remarks</td><td style="padding:7px 0;">%s</td></tr>
    <tr><td style="padding:7px 0;color:#5f768b;">Submitted On</td><td style="padding:7px 0;">%s</td></tr>
  </table>
  <a href="/admin/registration-requests" style="display:inline-block;margin-top:8px;padding:10px 24px;background:#FC934C;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">Review Request →</a>
</div></div>`, fullName, emailAddr, designation, remarks, time.Now().Format("02 Jan 2006, 15:04")),
	)
}

func SendRegistrationRejected(to, userName, reason string) error {
	reasonHTML := ""
	if reason != "" {
		reasonHTML = fmt.Sprintf(`<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;color:#92400e;"><strong>Reason:</strong> %s</div>`, reason)
	}
	return sendTemplate("registration_rejected", to, map[string]string{
		"user_name": userName, "email": to, "rejection_reason": reason,
	},
		"Update on Your IP House Registration",
		fmt.Sprintf(`<div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;"><h2 style="color:#14254A;">Registration Update</h2><p>Dear <strong>%s</strong>, your registration could not be approved.</p>%s</div>`, strings.TrimSpace(userName), reasonHTML),
	)
}
