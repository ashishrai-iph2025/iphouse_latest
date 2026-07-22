-- Migration: Add per-report dashboard assignment for embed authorisation
-- Purpose: Implement per-report embed token authorization
-- Date: 2024-07-22

-- ────────────────────────────────────────────────────────────────────────────
-- Table: user_dashboard_assignment
-- Purpose: Maps users/logins to specific Power BI reports they're authorized to view
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_dashboard_assignment (
    id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT 'Primary key',
    login_id BIGINT NOT NULL COMMENT 'FK to dcp_user_login.loginId',
    user_id BIGINT NOT NULL COMMENT 'FK to dcp_user.userId',
    report_id VARCHAR(255) NOT NULL COMMENT 'Power BI report ID (UUID)',
    dashboard_name VARCHAR(255) COMMENT 'Human-readable dashboard name for audit log',
    workspace_id VARCHAR(255) COMMENT 'Power BI workspace ID',
    is_active TINYINT(1) DEFAULT 1 COMMENT 'Soft delete flag (1=active, 0=revoked)',
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'When this assignment was created',
    assigned_by BIGINT COMMENT 'Admin user ID who created the assignment',
    revoked_at TIMESTAMP NULL COMMENT 'When this assignment was revoked',
    revoked_by BIGINT COMMENT 'Admin user ID who revoked the assignment',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Constraints
    UNIQUE KEY uk_login_report (login_id, report_id) COMMENT 'Each login can be assigned to a report only once',
    KEY fk_login_id (login_id) COMMENT 'Index for lookups by login',
    KEY fk_user_id (user_id) COMMENT 'Index for lookups by user',
    KEY fk_report_id (report_id) COMMENT 'Index for lookups by report',
    KEY idx_is_active (is_active) COMMENT 'Index for active assignments',

    -- Foreign key constraints
    CONSTRAINT fk_uda_login FOREIGN KEY (login_id)
        REFERENCES dcp_user_login (loginId)
        ON DELETE CASCADE,
    CONSTRAINT fk_uda_user FOREIGN KEY (user_id)
        REFERENCES dcp_user (userId)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Maps users to Power BI reports for per-report embed authorization';

-- ────────────────────────────────────────────────────────────────────────────
-- Index for common queries
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_active_assignments
ON user_dashboard_assignment(login_id, is_active)
COMMENT='Speed up active assignment lookups during embed token generation';

-- ────────────────────────────────────────────────────────────────────────────
-- View: active_dashboard_assignments
-- Purpose: Simplify queries for currently active assignments
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW active_dashboard_assignments AS
SELECT
    uda.id,
    uda.login_id,
    uda.user_id,
    uda.report_id,
    uda.dashboard_name,
    uda.workspace_id,
    uda.assigned_at,
    ul.login_username,
    u.name AS user_name,
    u.email
FROM user_dashboard_assignment uda
INNER JOIN dcp_user_login ul ON ul.loginId = uda.login_id
INNER JOIN dcp_user u ON u.userId = uda.user_id
WHERE uda.is_active = 1
AND ul.is_active = 1
AND u.deleted = 0
ORDER BY uda.assigned_at DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- SECURITY NOTES
-- ────────────────────────────────────────────────────────────────────────────
--
-- 1. AUTHORIZATION CHECK
--    When EmbedToken is called, it now verifies:
--    - User/login has an active assignment to the requested report_id
--    - If no assignment exists, embed token generation fails with 403
--
-- 2. ASSIGNMENT WORKFLOW
--    Super Admins must explicitly assign reports to users/logins:
--    - Via /api/admin/user-dashboard-assignment endpoint (to be created)
--    - By inserting into user_dashboard_assignment table
--    - NO automatic access based on role or client membership
--
-- 3. SOFT DELETES
--    Assignments are soft-deleted (is_active=0), not hard-deleted:
--    - Preserves audit trail of who had access when
--    - Enables quick re-grant (update is_active=1) if needed
--    - revoked_at tracks when access was removed
--
-- 4. AUDIT TRAIL
--    Every assignment/revocation includes:
--    - assigned_by / revoked_by (admin user ID)
--    - assigned_at / revoked_at (timestamps)
--    - All data logged for compliance
--
-- 5. ENFORCEMENT
--    The EmbedToken handler now checks:
--    - SELECT 1 FROM user_dashboard_assignment WHERE login_id=? AND report_id=? AND is_active=1
--    - If query returns NULL → HTTP 403 "You do not have access to this report"
--    - Prevents cross-tenant embed token generation
--
-- ────────────────────────────────────────────────────────────────────────────
