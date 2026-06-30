/**
 * Central email utility.
 * All outgoing emails go through sendTemplateEmail(), which:
 *   1. Looks up an active template in dcp_email_templates by event_key
 *   2. Renders {{variable}} placeholders
 *   3. Sends via SMTP credentials stored in master_email_credentials (DB)
 *      — falls back to .env SMTP settings if no DB credential is active
 *   4. Falls back to a hardcoded HTML body if no DB template exists yet
 */

import nodemailer from 'nodemailer'
import { queryOne } from './db'
import { decrypt } from './crypto'

// ── SMTP ──────────────────────────────────────────────────────────────────────

async function getSmtpConfig() {
  const row = await queryOne<any>(
    'SELECT email_id, email_password, smtp_host, smtp_port, smtp_secure FROM master_email_credentials WHERE is_active = 1 ORDER BY id DESC LIMIT 1'
  ).catch(() => null)
  if (!row) return null
  return {
    host:   row.smtp_host,
    port:   row.smtp_port,
    secure: row.smtp_secure === 'ssl' || row.smtp_port === 465,
    auth: {
      user: decrypt(row.email_id)       || row.email_id,
      pass: decrypt(row.email_password) || row.email_password,
    },
    from: decrypt(row.email_id) || row.email_id,
  }
}

function buildTransporter(smtp: Awaited<ReturnType<typeof getSmtpConfig>>) {
  if (smtp) {
    return nodemailer.createTransport({
      host:   smtp.host,
      port:   smtp.port,
      secure: smtp.secure,
      auth:   smtp.auth,
    })
  }
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || 'localhost',
    port:   Number(process.env.SMTP_PORT  || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  })
}

// ── Template rendering ────────────────────────────────────────────────────────

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// ── Core dispatcher ───────────────────────────────────────────────────────────

export async function sendTemplateEmail(
  eventKey: string,
  to: string,
  vars: Record<string, string>,
  fallback: { subject: string; html: string }
): Promise<void> {
  // Try to load active DB template
  const tpl = await queryOne<{ subject: string; body_html: string }>(
    'SELECT subject, body_html FROM dcp_email_templates WHERE event_key = ? AND is_active = 1 LIMIT 1',
    [eventKey]
  ).catch(() => null)

  const subject = tpl ? render(tpl.subject,   vars) : fallback.subject
  const html    = tpl ? render(tpl.body_html, vars) : fallback.html

  const smtp        = await getSmtpConfig()
  const transporter = buildTransporter(smtp)
  const from        = smtp
    ? `IP House <${smtp.from}>`
    : (process.env.SMTP_FROM || 'IP House <noreply@iphouse.com>')

  await transporter.sendMail({ from, to, subject, html })
}

// ── Named helpers (each has a built-in fallback) ──────────────────────────────

export async function sendOtpEmail(
  to: string,
  code: string,
  userName = ''
): Promise<void> {
  await sendTemplateEmail(
    'otp_verification',
    to,
    { otp_code: code, user_name: userName, expiry_minutes: '10' },
    {
      subject: 'Your IP House Login Code',
      html: `
        <div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#14254A;font-size:20px;margin:0 0 8px;">Email Verification</h2>
          <p style="color:#5f768b;margin:0 0 24px;">Use the code below to complete your login. It expires in <strong>10 minutes</strong>.</p>
          <div style="background:#f3f6fb;border-radius:10px;padding:24px;text-align:center;letter-spacing:10px;font-size:36px;font-weight:700;color:#14254A;">
            ${code}
          </div>
          <p style="color:#9ca3af;font-size:13px;margin-top:24px;">If you did not request this code, please ignore this email.</p>
        </div>
      `,
    }
  )
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string,
  userName = ''
): Promise<void> {
  await sendTemplateEmail(
    'password_reset_token',
    to,
    { user_name: userName, reset_token: resetToken, expiry_time: '30 minutes' },
    {
      subject: 'Reset Your IP House Password',
      html: `
        <div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#14254A;font-size:20px;margin:0 0 8px;">Reset Password</h2>
          <p style="color:#5f768b;margin:0 0 8px;">Hi <strong>${userName}</strong>,</p>
          <p style="color:#5f768b;margin:0 0 24px;">Copy the reset token below and paste it on the reset page. It expires in <strong>30 minutes</strong>.</p>
          <div style="background:#f3f6fb;border-radius:10px;padding:20px 24px;word-break:break-all;font-family:monospace;font-size:14px;font-weight:700;color:#14254A;letter-spacing:1px;border:1px dashed #c7d2e0;">
            ${resetToken}
          </div>
          <p style="color:#9ca3af;font-size:13px;margin-top:24px;">Go to the forgot-password page, paste this token, and set your new password. If you did not request this, please ignore.</p>
        </div>
      `,
    }
  )
}

export async function sendRegistrationApprovedEmail(
  to: string,
  userName: string,
  username: string,
  password: string,
  loginUrl: string
): Promise<void> {
  await sendTemplateEmail(
    'registration_approved',
    to,
    { user_name: userName, email: username, password, login_url: loginUrl, date: new Date().toLocaleDateString('en-GB') },
    {
      subject: 'Dashboard Access Enabled – Your IP House Credentials',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
          <div style="background:#14254A;padding:24px 32px;text-align:center;">
            <h1 style="color:#fff;font-size:22px;margin:0;font-weight:700;">Dashboard Access Enabled</h1>
          </div>
          <div style="padding:32px;">
            <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a;">Dear <strong>${userName}</strong>,</p>
            <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;">We are pleased to inform you that access to your online dashboard has been successfully enabled. You can access your dashboard using the details below:</p>
            <div style="border:1px solid #d1d5db;border-radius:6px;padding:20px 24px;margin:0 0 24px;">
              <p style="margin:0 0 12px;font-size:15px;color:#1a1a1a;"><strong>Dashboard URL:</strong><br>
                <a href="${loginUrl}" style="color:#1d4ed8;text-decoration:none;">${loginUrl}</a></p>
              <p style="margin:0 0 8px;font-size:15px;color:#1a1a1a;"><strong>Username:</strong> <a href="mailto:${username}" style="color:#1d4ed8;text-decoration:none;">${username}</a></p>
              <p style="margin:0;font-size:15px;color:#1a1a1a;"><strong>Password:</strong> ${password}</p>
            </div>
            <h2 style="font-size:16px;color:#1a1a1a;margin:0 0 10px;">🔐 Important Security Information</h2>
            <p style="margin:0 0 10px;font-size:15px;color:#333;line-height:1.6;">For enhanced security, our system uses <strong>One-Time Password (OTP)</strong>–based verification.</p>
            <p style="margin:0 0 24px;font-size:15px;color:#333;line-height:1.6;">Each time you log in, an OTP will be sent to your registered email address. Please enter the OTP to complete the login process.</p>
            <h2 style="font-size:16px;color:#1a1a1a;margin:0 0 10px;">✅ Recommended Next Steps</h2>
            <ol style="margin:0 0 24px;padding-left:20px;font-size:15px;color:#333;line-height:1.8;">
              <li>Log in using the credentials provided above.</li>
              <li>Verify your access using the OTP sent to your email.</li>
              <li>Change your password after your first successful login.</li>
            </ol>
            <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;">If you face any issues while accessing the dashboard or do not receive the OTP, please contact our support team at <a href="mailto:india-itsupport@ip-house.com" style="color:#1d4ed8;">india-itsupport@ip-house.com</a>.</p>
            <p style="margin:0 0 24px;font-size:15px;color:#333;line-height:1.6;">Thank you for choosing us. We look forward to supporting your reporting and analytics needs.</p>
            <p style="margin:0;font-size:15px;color:#333;">Warm regards,<br><strong>Team IP House</strong></p>
          </div>
        </div>
      `,
    }
  )
}

export async function sendRegistrationRejectedEmail(
  to: string,
  userName: string,
  reason = ''
): Promise<void> {
  await sendTemplateEmail(
    'registration_rejected',
    to,
    { user_name: userName, email: to, rejection_reason: reason || 'No reason provided' },
    {
      subject: 'Update on Your IP House Registration',
      html: `
        <div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
          <h2 style="color:#14254A;font-size:20px;margin:0 0 16px;">Registration Update</h2>
          <p style="color:#5f768b;margin:0 0 8px;">Dear <strong>${userName}</strong>,</p>
          <p style="color:#5f768b;margin:0 0 16px;">Unfortunately, your registration request could not be approved at this time.</p>
          ${reason ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px 16px;color:#92400e;font-size:13px;margin-bottom:16px;"><strong>Reason:</strong> ${reason}</div>` : ''}
          <p style="color:#9ca3af;font-size:13px;">If you have questions, please contact our support team.</p>
        </div>
      `,
    }
  )
}
