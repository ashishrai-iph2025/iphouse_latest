-- ═══════════════════════════════════════════════════════════════════
--  IP House Reports — Database Schema
--  Compatible with MySQL 5.7+ / MariaDB 10.3+
-- ═══════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ── Users (parent account) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_user` (
  `userId`        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `name`          VARCHAR(255)  NOT NULL DEFAULT '',
  `email`         VARCHAR(255)  NOT NULL DEFAULT '',
  `role`          TINYINT       DEFAULT NULL COMMENT '1=admin, 2=client',
  `IsSecure`      TINYINT       NOT NULL DEFAULT 0,
  `twofa_secret`  VARCHAR(64)   DEFAULT NULL,
  `twofa_code`    VARCHAR(10)   DEFAULT NULL,
  `twofa_code_expires` DATETIME DEFAULT NULL,
  `api_user_name` VARCHAR(255)  DEFAULT '',
  `api_password`  VARCHAR(255)  DEFAULT '',
  `userLogo`      VARCHAR(500)  DEFAULT NULL,
  `companyLogo`   VARCHAR(500)  DEFAULT NULL,
  `deleted`       TINYINT       NOT NULL DEFAULT 0,
  `created_at`    DATETIME      DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Login credentials (one user may have many logins / shared logins) ─
CREATE TABLE IF NOT EXISTS `dcp_user_login` (
  `loginId`        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`         INT UNSIGNED DEFAULT NULL COMMENT 'NULL = approved registrant awaiting client assignment',
  `first_name`     VARCHAR(128) NOT NULL DEFAULT '',
  `last_name`      VARCHAR(128) NOT NULL DEFAULT '',
  `login_username` VARCHAR(255) NOT NULL DEFAULT '',
  `login_password` VARCHAR(255) NOT NULL DEFAULT '',
  `login_type`     TINYINT      NOT NULL DEFAULT 0 COMMENT '0=email OTP, 1=TOTP, 2=password',
  `twofa_secret`   VARCHAR(64)  DEFAULT NULL,
  `is_active`      TINYINT      NOT NULL DEFAULT 1,
  `created_at`     DATETIME     DEFAULT NULL COMMENT 'stamped by the app with UTC_TIMESTAMP() on insert',
  `updated_at`     DATETIME     DEFAULT NULL COMMENT 'stamped by the app with UTC_TIMESTAMP() on every update',
  KEY `idx_username` (`login_username`),
  CONSTRAINT `fk_login_user` FOREIGN KEY (`userId`) REFERENCES `dcp_user` (`userId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Login history ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_login` (
  `id`        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`    INT UNSIGNED NOT NULL,
  `loginId`   INT UNSIGNED DEFAULT NULL,
  `loginTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_userId`  (`userId`),
  KEY `idx_loginId` (`loginId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── PowerBI dashboard access log (per-user) ──────────────────────────
CREATE TABLE IF NOT EXISTS `user_dashboard_access` (
  `id`             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `login_id`       INT UNSIGNED NOT NULL,
  `user_id`        INT UNSIGNED NOT NULL,
  `report_id`      VARCHAR(128) NOT NULL,
  `dashboard_name` VARCHAR(255) DEFAULT '',
  `workspace_id`   VARCHAR(128) DEFAULT '',
  `accessed_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_uda_login`   (`login_id`),
  KEY `idx_uda_report`  (`report_id`),
  KEY `idx_uda_user`    (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Modules ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_module` (
  `moduleId`   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `moduleName` VARCHAR(128) NOT NULL DEFAULT '',
  `moduleIcon` VARCHAR(64)  NOT NULL DEFAULT '',
  `deleted`    TINYINT      NOT NULL DEFAULT 0,
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Module ↔ User mapping ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_user_module_map` (
  `mapId`     INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`    INT UNSIGNED NOT NULL,
  `moduleId`  INT UNSIGNED NOT NULL,
  `link`      VARCHAR(500) NOT NULL DEFAULT '',
  `noLinkMsg` VARCHAR(255) NOT NULL DEFAULT '',
  `active`    TINYINT      NOT NULL DEFAULT 1,
  `default`   TINYINT      NOT NULL DEFAULT 0,
  UNIQUE KEY `uq_user_module` (`userId`, `moduleId`),
  CONSTRAINT `fk_modmap_user`   FOREIGN KEY (`userId`)   REFERENCES `dcp_user`   (`userId`)   ON DELETE CASCADE,
  CONSTRAINT `fk_modmap_module` FOREIGN KEY (`moduleId`) REFERENCES `dcp_module` (`moduleId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Dashboards (Power BI embed) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_dashboard` (
  `dashboardId` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`      INT UNSIGNED NOT NULL,
  `title`       VARCHAR(255) NOT NULL DEFAULT '',
  `embedUrl`    TEXT DEFAULT NULL,
  `active`      TINYINT      NOT NULL DEFAULT 1,
  `created_at`  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_dash_user` FOREIGN KEY (`userId`) REFERENCES `dcp_user` (`userId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Email credentials ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_email_credentials` (
  `id`        INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `smtp_host` VARCHAR(255) NOT NULL DEFAULT '',
  `smtp_port` SMALLINT     NOT NULL DEFAULT 587,
  `smtp_user` VARCHAR(255) NOT NULL DEFAULT '',
  `smtp_pass` VARCHAR(255) NOT NULL DEFAULT '',
  `smtp_from` VARCHAR(255) NOT NULL DEFAULT '',
  `is_active` TINYINT      NOT NULL DEFAULT 1,
  `updated_at` DATETIME    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Notifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_notifications` (
  `notificationId` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`         INT UNSIGNED NOT NULL,
  `message`        TEXT NOT NULL,
  `type`           VARCHAR(64)  NOT NULL DEFAULT 'info',
  `is_read`        TINYINT      NOT NULL DEFAULT 0,
  `created_at`     DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_user_notif` (`userId`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── User activity log ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `user_activity_log` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`    INT UNSIGNED NOT NULL,
  `page_url`   VARCHAR(500) DEFAULT '',
  `action`     VARCHAR(64)  DEFAULT 'view',
  `ip_address` VARCHAR(45)  DEFAULT '',
  `user_agent` VARCHAR(500) DEFAULT '',
  `metadata`   TEXT         NULL DEFAULT NULL,
  `created_at` DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_user_activity` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── User idle timeout per user ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS `user_idle_settings` (
  `id`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `user_id`      INT UNSIGNED NOT NULL UNIQUE,
  `idle_minutes` SMALLINT     NOT NULL DEFAULT 30,
  `is_active`    TINYINT      NOT NULL DEFAULT 1,
  CONSTRAINT `fk_idle_user` FOREIGN KEY (`user_id`) REFERENCES `dcp_user` (`userId`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Password resets ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_password_resets` (
  `id`         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`     INT UNSIGNED NOT NULL,
  `token`      VARCHAR(128) NOT NULL,
  `expires_at` DATETIME     NOT NULL,
  `used`       TINYINT      NOT NULL DEFAULT 0,
  UNIQUE KEY `uq_token` (`token`),
  KEY `idx_user_reset` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Registration requests ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_registration_requests` (
  `requestId`    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `full_name`    VARCHAR(255) NOT NULL DEFAULT '',
  `email`        VARCHAR(255) NOT NULL DEFAULT '',
  `username`     VARCHAR(255) NOT NULL DEFAULT '',
  `password_raw` VARCHAR(255) NOT NULL DEFAULT '',
  `company`      VARCHAR(255) NOT NULL DEFAULT '',
  `status`       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `created_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_reg_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Email templates ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_email_templates` (
  `id`          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `name`        VARCHAR(255) NOT NULL DEFAULT '',
  `event_key`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'e.g. registration_approved, registration_rejected, infringement_submitted',
  `subject`     VARCHAR(500) NOT NULL DEFAULT '',
  `body_html`   MEDIUMTEXT   NOT NULL,
  `is_active`    TINYINT      NOT NULL DEFAULT 1,
  `notify_email` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'Override recipient for admin-notification templates',
  `created_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_event_key` (`event_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Email event types (dynamic, admin-managed) ───────────────────────
CREATE TABLE IF NOT EXISTS `dcp_email_event_types` (
  `id`              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `key`             VARCHAR(64)   NOT NULL DEFAULT '' COMMENT 'Unique event key used in code e.g. registration_approved',
  `label`           VARCHAR(255)  NOT NULL DEFAULT '' COMMENT 'Human-readable label shown in UI dropdowns',
  `description`     VARCHAR(500)  NOT NULL DEFAULT '',
  `has_notify_email` TINYINT      NOT NULL DEFAULT 0 COMMENT '1 = show recipient email field on template form',
  `variables`       TEXT          NOT NULL COMMENT 'Comma-separated list of available {{placeholders}}',
  `sort_order`      SMALLINT      NOT NULL DEFAULT 0,
  `is_active`       TINYINT       NOT NULL DEFAULT 1,
  `created_at`      DATETIME      DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_eet_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed built-in event types
INSERT IGNORE INTO `dcp_email_event_types` (`key`, label, description, has_notify_email, variables, sort_order, is_active) VALUES
('otp_verification',                'OTP / Email Verification',             'Sent when a user requests a login OTP.',                              0, '{{otp_code}},{{user_name}},{{expiry_minutes}}',                                              1,  1),
('registration_received_applicant', 'Registration Received – Applicant',    'Confirmation sent to the person who submitted a registration form.',  0, '{{full_name}},{{first_name}},{{last_name}},{{email}},{{designation}},{{date}}',              2,  1),
('registration_received_admin',     'Registration Received – Admin Notify', 'Admin notification when a new registration request is submitted.',    1, '{{full_name}},{{first_name}},{{last_name}},{{email}},{{designation}},{{remarks}},{{date}}',  3,  1),
('registration_approved',           'User Registration Approved',           'Sent to the user when their registration is approved.',               0, '{{user_name}},{{email}},{{password}},{{login_url}},{{date}}',                                4,  1),
('registration_rejected',           'User Registration Rejected',           'Sent to the user when their registration is rejected.',               0, '{{user_name}},{{email}},{{rejection_reason}}',                                               5,  1),
('password_reset',                  'Password Reset',                       'Sent when a user requests a password reset.',                         0, '{{user_name}},{{reset_link}},{{expiry_time}}',                                               6,  1),
('account_created',                 'Account Created',                      'Sent when an admin creates an account for a user.',                   0, '{{user_name}},{{email}},{{login_url}}',                                                      7,  1),
('infringement_client_confirmation','Takedown – Client Confirmation',       'Confirms a takedown batch submission to the client email.',           0, '{{name}},{{platform}},{{asset_name}},{{remarks}},{{url_count}},{{urls_list}},{{date}}',      8,  1),
('infringement_user_notification',  'Takedown – User Notification',         'Notifies the logged-in dashboard user of their submission.',          0, '{{user_name}},{{platform}},{{asset_name}},{{url_count}},{{urls_list}},{{date}}',             9,  1),
('custom',                          'Custom / Other',                       'Use for any custom or ad-hoc email template.',                        0, '{{custom_var_1}},{{custom_var_2}}',                                                          99, 1);

-- ── Download requests ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `dcp_download_requests` (
  `id`           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `userId`       INT UNSIGNED NOT NULL,
  `requestId`    VARCHAR(128) NOT NULL DEFAULT '',
  `platform`     VARCHAR(64)  NOT NULL DEFAULT '',
  `asset_name`   VARCHAR(255) NOT NULL DEFAULT '',
  `start_date`   VARCHAR(32)  NOT NULL DEFAULT '',
  `end_date`     VARCHAR(32)  NOT NULL DEFAULT '',
  `status`       VARCHAR(32)  NOT NULL DEFAULT 'pending',
  `download_url` TEXT DEFAULT NULL,
  `created_at`   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_dl_user` (`userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Super Admins (isolated table, separate credentials) ─────────────
-- Role=2 accounts NEVER appear in dcp_user / dcp_user_login.
-- Auth checks this table first before falling through to dcp_user_login.
CREATE TABLE IF NOT EXISTS `dcp_super_admin` (
  `id`            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  `name`          VARCHAR(255) NOT NULL DEFAULT '',
  `email`         VARCHAR(255) NOT NULL DEFAULT '',
  `password_hash` VARCHAR(255) NOT NULL DEFAULT '' COMMENT 'bcrypt only — no MD5',
  `is_active`     TINYINT      NOT NULL DEFAULT 1,
  `last_login`    DATETIME     DEFAULT NULL,
  `created_at`    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_sa_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Seed: super admin — ashish.rai@ip-house.com ──────────────────────
-- Default password: SuperAdmin@2024  (bcrypt $2a$12$...)
-- CHANGE THIS IMMEDIATELY after first login via /admin/super-admin/profile
INSERT IGNORE INTO `dcp_super_admin` (`name`, `email`, `password_hash`, `is_active`)
VALUES (
  'Ashish Rai',
  'ashish.rai@ip-house.com',
  '$2a$12$q2Na9E9OLPHSH77L39unWODReeujC.BvFFyHEHcw0Y1qoKOr.Mw.u',
  1
);

-- ── Seed: default admin user ─────────────────────────────────────────
-- Password is 'admin123' (bcrypt); CHANGE THIS IMMEDIATELY in production
INSERT IGNORE INTO `dcp_user` (`userId`, `name`, `email`, `role`, `deleted`)
VALUES (1, 'System Admin', 'admin@iphouse.com', 1, 0);

INSERT IGNORE INTO `dcp_user_login`
  (`loginId`, `userId`, `first_name`, `login_username`, `login_password`, `login_type`, `is_active`)
VALUES
  (1, 1, 'Admin', 'admin@iphouse.com',
   '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj/RK.s5udem',
   2, 1);

-- ── Seed: default modules ───────────────────────────────────────────
INSERT IGNORE INTO `dcp_module` (`moduleId`, `moduleName`, `moduleIcon`, `deleted`) VALUES
  (1,  'YouTube',              '▶',  0),
  (2,  'Facebook',             'f',  0),
  (3,  'Instagram',            '📷', 0),
  (4,  'Twitter / X',          '𝕏', 0),
  (5,  'Telegram',             '✈',  0),
  (6,  'Internet',             '🌐', 0),
  (7,  'TikTok',               '♪',  0),
  (8,  'VK',                   'В',  0),
  (9,  'OK',                   '✓',  0),
  (10, 'Dailymotion',          '▶',  0),
  (11, 'Bilibili',             'B',  0),
  (12, 'ShareChat',            'S',  0),
  (13, 'Chomikuj',             'C',  0),
  (14, 'UGC & Other SM',       '📱', 0),
  (15, 'iTunes / App Store',   '',   0),
  (16, 'Google Play Store',    '▶',  0),
  (17, 'Third Party App',      '📦', 0),
  (18, 'Third Party Mobile',   '📲', 0),
  (19, 'IP Tracking',          '🌐', 0),
  (20, 'Download Requests',    '📥', 0);

SET FOREIGN_KEY_CHECKS = 1;
