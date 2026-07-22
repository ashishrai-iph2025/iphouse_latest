# Dependency & Runtime Patch Cadence Policy

**Version**: 1.0  
**Effective Date**: 2024-07-22  
**Last Updated**: 2024-07-22  
**Owner**: Security & DevOps Team

---

## Overview

This policy establishes a structured schedule for reviewing and applying security patches and dependency updates across the IPHouse platform. The goal is to balance security (applying patches quickly) with stability (testing before production).

---

## Security Update Cadence

### Critical & High-Severity CVEs

**Timeline**: IMMEDIATE (same day)  
**Process**:
1. Receive notification (GitHub alerts, Dependabot, npm audit)
2. Review CVE severity and affected components
3. If severity is CRITICAL or HIGH:
   - Patch in dev immediately
   - Test for 1-2 hours
   - Create emergency PR with detailed testing notes
   - Deploy to production within same business day

**Example Critical CVE**:
```
- Node.js security vulnerability in core crypto library
- Go package RCE vulnerability
- Docker base image kernel vulnerability
```

### Medium-Severity CVEs

**Timeline**: 1 week  
**Process**:
1. Create PR during next weekly patch window
2. Run full test suite
3. Deploy to staging for 24-48 hours
4. Deploy to production in next standard release

### Low-Severity CVEs

**Timeline**: Next monthly patch cycle  
**Process**:
1. Batch with other low-severity updates
2. Include in standard monthly patch
3. Test with other updates
4. Deploy in production release

---

## Dependency Update Cadence

### Automated Updates (via Dependabot)

Dependabot creates PRs on a weekly schedule:

**Monday**: npm dependencies  
**Tuesday**: Go modules  
**Wednesday**: Docker base images  
**Thursday**: GitHub Actions  

### npm Dependency Updates

**Security Patches** (semver patch: 1.0.x)
- Automatic: Dependabot creates PR
- Review: Check if it's security or bug fix
- Merge: Yes, typically same day if tests pass
- Deploy: Next release

**Minor Updates** (semver minor: 1.x.0)
- Automatic: Dependabot creates PR
- Review: Check changelog for breaking changes
- Merge: If backward compatible AND tests pass
- Deploy: Next planned release

**Major Updates** (semver major: x.0.0)
- Automatic: Dependabot creates PR
- Review: DETAILED changelog review
- Merge: Only if needed for security or critical bug
- Deploy: Requires full regression testing
- Timeline: 2+ weeks of testing before production

**Command**: `npm outdated` - Shows all available updates with major/minor/patch  
**Config**: `.github/dependabot.yml` - Determines update frequency

### Go Dependency Updates

**Security Patches**:
- Automatic: Dependabot creates PR
- Review: Check if security-related
- Merge: Yes, if tests pass
- Deploy: Next release

**Minor/Major Updates**:
- Automatic: Dependabot creates PR
- Review: Check for API changes, deprecated functions
- Merge: If no breaking changes in go.mod
- Deploy: Next planned release

**Command**: `go list -u -m all` - Shows available updates  
**Config**: `.github/dependabot.yml` - Determines update frequency

### Docker Base Image Updates

**Alpine Linux** (prod runtime)
- `alpine:latest` → Pin specific version (e.g., `alpine:3.20`)
- Update quarterly (Jan, Apr, Jul, Oct)
- Test for 1 week before deploying to prod

**Node.js** (frontend build stage)
- Keep on LTS version (currently 20)
- Update monthly for security patches
- Major version updates: Quarterly review

**Go** (backend build stage)
- Keep 1-2 versions behind latest
- Update monthly for security patches
- Major version updates: Quarterly

### GitHub Actions Updates

**Frequency**: Weekly (via Dependabot)  
**Review**: Check for breaking changes  
**Deploy**: Typically same day if CI still passes

---

## Quarterly Patch Cycles

### January Cycle (Q1)
```
Week 1-2:  Base image updates (Node, Go, Alpine)
Week 3:    All dependency updates
Week 4:    Full regression testing + production deploy
Timeline:  Full month for validation
```

### April Cycle (Q2)
```
Week 1-2:  Base image updates
Week 3:    All dependency updates
Week 4:    Full regression testing + production deploy
```

### July Cycle (Q3)
```
Week 1-2:  Base image updates
Week 3:    All dependency updates
Week 4:    Full regression testing + production deploy
```

### October Cycle (Q4)
```
Week 1-2:  Base image updates
Week 3:    All dependency updates
Week 4:    Full regression testing + production deploy
```

---

## Testing Requirements Before Deployment

### For Security Patches
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] No new console errors/warnings
- [ ] Smoke test on staging (5 min)
- [ ] Ready for immediate production deployment

### For Minor/Patch Updates
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] All security scans pass (`npm audit`, Trivy)
- [ ] 24-48 hour soak test on staging
- [ ] No performance regressions

### For Major Updates
- [ ] All above requirements
- [ ] Full regression test suite (2+ hours)
- [ ] Staging environment matches production
- [ ] Manual smoke test of critical flows
- [ ] Rollback plan documented
- [ ] Minimum 1 week soak test on staging
- [ ] Senior engineer approval required

---

## Automated Scanning & Monitoring

### Daily Scans (via GitHub Actions)

Runs automatically every day at 2 AM UTC:

```yaml
✓ Docker image scan (Trivy)
  - Scans built image for CVEs
  - Fails build if CRITICAL found
  - Reports HIGH severity

✓ npm audit
  - Audits production dependencies only (--omit=dev)
  - Fails if HIGH/CRITICAL found
  - Reports all issues

✓ Go vulnerability scan
  - Checks go.mod for known vulnerabilities
  - Reports all issues
  - Advisory tracking

✓ SBOM generation
  - Creates software bill of materials
  - Tracks all dependencies
  - Compliance documentation

✓ Dependabot checks
  - Looks for available updates
  - Creates PRs for new versions
  - Follows schedule in dependabot.yml
```

### GitHub Security Alerts

When enabled:
- Notifies on new CVEs in dependencies
- Creates draft security updates (requires approval)
- Links to CVE details and remediation

### SBOM (Software Bill of Materials)

Generated after every build:
- Location: `sbom.cyclonedx.json`
- Format: CycloneDX (industry standard)
- Contents: All direct and transitive dependencies
- Purpose: Compliance, audit trail, vulnerability tracking

---

## Approval & Escalation

### Minor/Patch Updates
- **Approval**: Any team member can review & merge
- **Escalation**: If tests fail, flag to senior engineer

### Major Updates
- **Approval**: REQUIRED from tech lead or senior engineer
- **Escalation**: If any regression found, document and create issue
- **Timeline**: Min 1 week soak test before production

### Emergency Security Patches
- **Approval**: First responder (on-call engineer)
- **Escalation**: Notify team lead after deployment
- **Timeline**: Deploy same business day if possible

---

## Process Workflow

### Weekly Dependabot PRs

```
1. Dependabot creates PR (e.g., Monday morning)
   ↓
2. CI runs automatically
   - Tests ✓
   - Linters ✓
   - Security scans ✓
   ↓
3. Team reviews PR
   - Check changelog
   - Verify no breaking changes
   - Approve or request changes
   ↓
4. Merge to main/production branch
   ↓
5. Deploy to production
   - For security patches: same day
   - For minor: next scheduled release
   - For major: after full testing
```

### Emergency Security Patch

```
1. CVE notification received (CRITICAL/HIGH)
   ↓
2. On-call engineer investigates
   - Determines if affects us
   - Assesses impact
   ↓
3. Create emergency patch PR
   - Update dependency version
   - Run full test suite
   - 1-2 hour validation
   ↓
4. Immediate approval & merge
   ↓
5. Deploy to production ASAP
   - Same business day if possible
   - Notify team after deployment
```

---

## Monitoring & Alerts

### During Patch Application

```
✓ npm audit passes
✓ Security scans pass (Trivy, nancy)
✓ All tests pass
✓ No performance regression
✓ Staging environment stable
```

### After Production Deployment

```
✓ Error rates normal
✓ API response times normal
✓ No new security alerts
✓ All monitoring green
✓ User reports: none
```

---

## Tools & Configuration

### Dependabot
- **Config**: `.github/dependabot.yml`
- **Purpose**: Automated update PRs
- **Frequency**: Weekly (M-Th)
- **Behavior**: Creates one PR per dependency update

### GitHub Actions
- **Workflow**: `.github/workflows/security-scan.yml`
- **Runs**: Daily at 2 AM UTC
- **Tasks**: Docker scan, npm audit, Go audit, SBOM

### Local Testing
```bash
# Check for outdated packages
npm outdated

# Run security audit
npm audit --omit=dev --audit-level=high

# Scan Docker image
docker scan iphouse:latest
# OR install Trivy:
trivy image iphouse:latest

# Check for Go vulnerabilities
cd go-server && go list -u -m all
```

---

## Roles & Responsibilities

### Security Team
- [ ] Monitor security alerts (CVE feeds)
- [ ] Escalate CRITICAL/HIGH CVEs
- [ ] Review quarterly patch cycles
- [ ] Maintain this policy

### Development Team
- [ ] Review Dependabot PRs
- [ ] Run tests before merging
- [ ] Merge security patches promptly
- [ ] Test on staging before production

### DevOps / Release Team
- [ ] Deploy patches to production
- [ ] Monitor for issues after deployment
- [ ] Maintain baseline image versions
- [ ] Generate SBOM reports

### Tech Lead / Senior Engineer
- [ ] Approve major dependency updates
- [ ] Review breaking changes
- [ ] Escalate rollback if needed

---

## Exception Process

### When Can We Delay a Patch?

**Acceptable Reasons**:
- Major version update that requires code changes
- Known compatibility issue with our codebase
- Waiting for dependent package to release compatible version
- Breaking change that requires redesign

**NOT Acceptable Reasons**:
- "Too busy to review"
- "Tests are flaky"
- "Will update later"

**Exception Process**:
1. Document reason
2. Get senior engineer sign-off
3. Create issue to track (with deadline)
4. Add to backlog with priority

---

## Reporting & Compliance

### Weekly Report
```
- New CVEs patched: X
- Dependabot PRs merged: X
- Build failures: X
- Deployments: X
```

### Quarterly Review
```
- CVEs identified: X
- CVEs patched: X
- Average patch time: Y days
- Security incidents: Z
```

### Audit Trail
- All patches in git history
- SBOM in each release
- Dependabot PR records
- GitHub Actions logs

---

## Version History

| Date | Version | Changes |
|------|---------|---------|
| 2024-07-22 | 1.0 | Initial policy |

---

## Approval

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Security Lead | — | 2024-07-22 | — |
| Tech Lead | — | 2024-07-22 | — |
| DevOps Lead | — | 2024-07-22 | — |

---

## Related Documents

- `.github/dependabot.yml` - Automated update configuration
- `.github/workflows/security-scan.yml` - Daily security scanning
- `SECURITY_TESTING.md` - Testing procedures
- `Dockerfile` - Base image versions
