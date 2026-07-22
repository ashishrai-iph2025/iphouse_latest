# EC2 Security Groups & IP Masking Configuration Guide

**Version**: 1.0  
**Date**: 2024-07-22  
**Roadmap Item**: EC2 security groups & IP masking  
**Status**: Ready for Implementation  
**Environment**: Production (EC2 behind Cloudflare proxy)

---

## Overview

This guide provides step-by-step instructions for configuring AWS EC2 security groups to restrict inbound traffic to Cloudflare IPs only (for HTTP/HTTPS) and whitelisted admin IPs (for SSH). This hardens your EC2 instance by:

1. **Blocking direct attacks** on your EC2 public IP
2. **Hiding real IP** behind Cloudflare proxy
3. **Restricting SSH access** to known admin IPs only
4. **Preventing unauthorized access** to your infrastructure

**Key Security Improvements**:
- ✅ Cloudflare IP masking (users never see EC2 real IP)
- ✅ Port 443/80 restricted to Cloudflare only
- ✅ Port 22 (SSH) restricted to admin IPs only
- ✅ All other ports denied by default
- ✅ Egress unrestricted (application can reach databases, APIs)

---

## Architecture

```
┌──────────────────────────────────────────┐
│          Internet Users                  │
└────────────────┬─────────────────────────┘
                 │
                 │ https://yourdomain.com
                 ↓
┌──────────────────────────────────────────┐
│    CLOUDFLARE GLOBAL NETWORK             │
│  (Proxy, WAF, DDoS, Rate Limiting)       │
└────────────────┬─────────────────────────┘
                 │
         Cloudflare IPs only
         (only IP 1.2.3.4-1.2.3.50)
                 ↓
┌──────────────────────────────────────────┐
│    AWS VPC (us-east-1)                   │
├──────────────────────────────────────────┤
│  Security Group Rules:                   │
│  ✓ Inbound: 443 (HTTPS) from CF IPs      │
│  ✓ Inbound: 80 (HTTP) from CF IPs        │
│  ✓ Inbound: 22 (SSH) from Admin IPs      │
│  ✓ Inbound: All else DENIED              │
│  ✓ Outbound: All ALLOWED (to DB, APIs)   │
│                                          │
│  EC2 Instance (i-0abc123def)             │
│  Private IP: 10.0.1.100                  │
│  Public IP: 54.123.45.67 (hidden)        │
└──────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────┐
│  Go Application (localhost:8080)         │
│  MySQL (private subnet)                  │
│  Redis (private subnet)                  │
└──────────────────────────────────────────┘
```

---

## Prerequisites

Before starting, verify you have:

✅ AWS account with EC2 instance running  
✅ EC2 instance has a security group attached  
✅ Cloudflare domain configured pointing to EC2  
✅ SSH access to EC2 (for testing)  
✅ List of admin IPs that need SSH access  
✅ Application running on ports 80 and 443 inside EC2  

**Check**: 
- SSH into your EC2 and verify application is running: `curl http://localhost:8080`
- Cloudflare DNS record points to EC2 public IP

---

## Part 1: Understanding Security Groups

### 1.1 Security Group Basics

A security group is a virtual firewall that controls:
- **Inbound traffic**: Who can reach your EC2
- **Outbound traffic**: Who your EC2 can reach
- **Protocol**: TCP, UDP, ICMP
- **Port**: Specific port or port range
- **Source/Destination**: IP, security group, or prefix list

### 1.2 Current State (Likely Too Open)

Most EC2 instances start with:
```
Inbound:
  ✗ 0.0.0.0/0 on port 22 (SSH from anywhere)
  ✗ 0.0.0.0/0 on port 80 (HTTP from anywhere)
  ✗ 0.0.0.0/0 on port 443 (HTTPS from anywhere)

Outbound:
  ✓ All traffic allowed
```

**Problem**: Attackers can directly access your EC2 IP without going through Cloudflare WAF/DDoS protection.

### 1.3 Target State (Hardened)

After this guide:
```
Inbound:
  ✓ Cloudflare IPs on port 443 (HTTPS)
  ✓ Cloudflare IPs on port 80 (HTTP)
  ✓ Admin IPs on port 22 (SSH)
  ✓ All else DENIED

Outbound:
  ✓ All traffic allowed
```

**Benefit**: Only Cloudflare can reach your app, all traffic goes through WAF first.

---

## Part 2: Gather Cloudflare IP Ranges

Cloudflare publishes their IP ranges publicly. You need to allowlist them.

### 2.1 Get Cloudflare IP Ranges

**Option A: Manual from Cloudflare**

```
1. Go to: https://www.cloudflare.com/ips/
2. You'll see two lists:
   - IPv4 Ranges (use these)
   - IPv6 Ranges (optional, for IPv6 support)
3. Download or copy the IPv4 list
```

**As of 2024, Cloudflare IPs include**:
```
173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
... (and more)
```

**Option B: Automate with Script**

```bash
# Download current Cloudflare IPs
curl -s https://www.cloudflare.com/ips-v4 > /tmp/cloudflare-ips.txt
cat /tmp/cloudflare-ips.txt
```

### 2.2 Collect Admin IPs

Create a list of static IPs for your admins:

```
Admin 1 (office): 203.0.113.5/32
Admin 2 (office): 203.0.113.6/32
Admin 3 (remote): 198.51.100.25/32
Admin 4 (VPN): 192.0.2.100/32
```

**Note**: If admins use dynamic IPs (ISP changes), use `/32` and update regularly, or use a VPN with static IP.

---

## Part 3: AWS Console - Security Group Configuration

### 3.1 Navigate to Security Groups

```
1. AWS Console → EC2 → Security Groups
2. Find your EC2 instance's security group
   (likely named "launch-wizard-X" or "default")
3. Select it → Click "Edit inbound rules"
```

### 3.2 Remove Overly Permissive Rules

**Before adding new rules, remove old ones**:

```
1. Find any rules allowing 0.0.0.0/0 on ports 80, 443, 22
2. Click the X button to delete
3. Common rules to delete:
   - 0.0.0.0/0 TCP 22 (SSH from anywhere)
   - 0.0.0.0/0 TCP 80 (HTTP from anywhere)
   - 0.0.0.0/0 TCP 443 (HTTPS from anywhere)
   - ::/0 TCP 80/443 (IPv6 versions)
4. Save
```

**Warning**: Don't do this before adding new rules or you'll lose SSH access!

### 3.3 Add Rule: HTTPS from Cloudflare IPs

```
1. Click "Add rule"
2. Configuration:
   Type: HTTPS
   Protocol: TCP
   Port: 443
   Source: Custom
   CIDR: Paste first Cloudflare IP range (e.g., 173.245.48.0/20)
3. Click "Add rule" again for each additional Cloudflare CIDR
4. Repeat for all Cloudflare IPs
```

**Result**: 20-30 rules, one per Cloudflare IP range

### 3.4 Add Rule: HTTP from Cloudflare IPs

```
1. Click "Add rule"
2. Configuration:
   Type: HTTP
   Protocol: TCP
   Port: 80
   Source: Custom
   CIDR: Paste first Cloudflare IP range
3. Add rule for each Cloudflare CIDR
```

### 3.5 Add Rule: SSH from Admin IPs

```
1. Click "Add rule"
2. Configuration:
   Type: SSH
   Protocol: TCP
   Port: 22
   Source: Custom
   CIDR: Paste first admin IP (e.g., 203.0.113.5/32)
3. Add rule for each admin IP
4. Click "Save inbound rules"
```

---

## Part 4: AWS CLI Configuration (Alternative/Bulk)

If you have many IPs, using AWS CLI is faster:

### 4.1 Script: Bulk Add Cloudflare IPs

```bash
#!/bin/bash

# Variables
SG_ID="sg-0abc123def456"  # Your security group ID
PROTOCOL="tcp"
PORT_HTTPS="443"
PORT_HTTP="80"

# Get Cloudflare IPs
curl -s https://www.cloudflare.com/ips-v4 > /tmp/cf-ips.txt

# Add HTTPS rules
echo "Adding HTTPS rules from Cloudflare IPs..."
while IFS= read -r ip; do
  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol $PROTOCOL \
    --port $PORT_HTTPS \
    --cidr $ip \
    --region us-east-1 \
    2>/dev/null && echo "Added $ip:443"
done < /tmp/cf-ips.txt

# Add HTTP rules
echo "Adding HTTP rules from Cloudflare IPs..."
while IFS= read -r ip; do
  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol $PROTOCOL \
    --port $PORT_HTTP \
    --cidr $ip \
    --region us-east-1 \
    2>/dev/null && echo "Added $ip:80"
done < /tmp/cf-ips.txt

echo "Done!"
```

### 4.2 Script: Add Admin SSH IPs

```bash
#!/bin/bash

# Variables
SG_ID="sg-0abc123def456"
ADMIN_IPS=(
  "203.0.113.5/32"
  "203.0.113.6/32"
  "198.51.100.25/32"
  "192.0.2.100/32"
)

echo "Adding SSH rules for admin IPs..."
for ip in "${ADMIN_IPS[@]}"; do
  aws ec2 authorize-security-group-ingress \
    --group-id $SG_ID \
    --protocol tcp \
    --port 22 \
    --cidr $ip \
    --region us-east-1 \
    2>/dev/null && echo "Added $ip:22"
done

echo "Done!"
```

---

## Part 5: Testing Access

### 5.1 Test: Cloudflare Can Reach Your App

```bash
# From any computer, access through Cloudflare domain
curl https://yourdomain.com/

# Expected: Your app responds (200 OK, HTML, etc.)
# This proves Cloudflare can reach your EC2
```

### 5.2 Test: Direct EC2 IP Blocked

```bash
# Get your EC2 public IP
EC2_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
echo $EC2_IP

# Try to access directly (from a non-admin IP)
curl https://$EC2_IP/
# or
curl http://$EC2_IP:8080/

# Expected: Connection timeout or refused
# This proves direct access is blocked
```

### 5.3 Test: SSH from Admin IP Works

```bash
# From an admin IP:
ssh -i /path/to/key.pem ec2-user@$EC2_IP

# Expected: SSH login succeeds
# This proves admin SSH works
```

### 5.4 Test: SSH from Non-Admin IP Blocked

```bash
# From a non-admin IP:
ssh -i /path/to/key.pem ec2-user@$EC2_IP

# Expected: Connection timeout or "No route to host"
# This proves SSH is restricted
```

### 5.5 Verify Outbound Connection (Database)

SSH into EC2 and test database connection:

```bash
# Inside EC2:
ssh ec2-user@$EC2_IP

# Test MySQL connection
mysql -h db-prod.abcdef.us-east-1.rds.amazonaws.com -u admin -p

# Expected: MySQL prompt (outbound works)
```

---

## Part 6: Troubleshooting

### Issue 1: Lost SSH Access

**Symptoms**: Can't SSH into EC2 after changes

**Solution**:
```
1. DO NOT PANIC - you didn't break anything
2. Use AWS Systems Manager Session Manager (EC2 Instance Connect)
   - AWS Console → EC2 → Select instance
   - Click "Connect" tab → "Session Manager" → "Connect"
3. Or use EC2 Instance Connect (if enabled)
   - Click "Connect" → "EC2 Instance Connect"
4. Once inside, check security group rules:
   ssh -i ~/.ssh/id_rsa ubuntu@localhost  # Test app access
4. Fix rules in AWS Console
```

### Issue 2: Application Unreachable

**Symptoms**: `curl https://yourdomain.com` times out

**Solution**:
```
1. Check security group allows Cloudflare IPs on 443
2. Verify Cloudflare DNS points to correct EC2 IP:
   nslookup yourdomain.com
3. Test from EC2 that app is listening:
   ssh into EC2
   curl http://localhost:8080
4. Check application logs:
   docker logs app-container
   or check systemd: journalctl -u myapp
```

### Issue 3: Cloudflare IPs Change

**Symptoms**: Traffic starts getting blocked randomly

**Solution**:
```
1. Cloudflare publishes IPs at https://www.cloudflare.com/ips/
2. Create a cron job to update rules monthly:
   0 0 1 * * /path/to/update-cf-ips.sh
3. Script should:
   - Get latest Cloudflare IPs
   - Remove old rules
   - Add new rules
```

### Issue 4: Port Conflicts

**Symptoms**: "Address already in use" on ports 80/443

**Solution**:
```
1. Check what's using the port:
   sudo netstat -tlnp | grep 80
   or: sudo lsof -i :80
2. If nginx/apache running:
   sudo systemctl stop nginx
3. Verify your app can bind:
   sudo netstat -tlnp | grep 8080
```

---

## Part 7: Monitoring & Maintenance

### 7.1 Weekly Review

```
- [ ] Check CloudTrail logs for failed SSH attempts
- [ ] Verify Cloudflare domain is resolving correctly
- [ ] Test application access through domain
- [ ] Review AWS console for security group changes
```

### 7.2 Monthly Review

```
- [ ] Update admin IP list (if any IPs changed)
- [ ] Check Cloudflare announces any IP changes
- [ ] Review inbound rules count (should be ~30-40)
- [ ] Verify no overly permissive rules crept in
```

### 7.3 Quarterly Tasks

```
- [ ] Full security group audit
- [ ] Test all admin SSH access methods
- [ ] Verify firewall rules haven't been modified
- [ ] Document any IP changes or rule updates
```

---

## Part 8: Advanced: IP Masking Verification

### 8.1 Verify Cloudflare Masking

```bash
# Users outside Cloudflare cannot see real EC2 IP
# But Cloudflare sees it

# From user perspective:
nslookup yourdomain.com
# Returns: Cloudflare IP (e.g., 104.21.12.34)

# From EC2 perspective:
curl -I https://yourdomain.com
# Shows Cloudflare's CF-Ray header
```

### 8.2 Monitor Real IP Exposure

```bash
# Check if real EC2 IP is leaked anywhere
# Search for EC2 IP in:
# - DNS records
# - Email headers
# - SSL certificates (use: transparencyreport.google.com)
# - WHOIS lookups

# Should only see Cloudflare IPs publicly
```

---

## Part 9: Security Group Best Practices

### 9.1 Principle of Least Privilege

```
✓ Only allow what's needed
  - Port 443 from Cloudflare only
  - Port 80 from Cloudflare only
  - Port 22 from admin IPs only

✗ Never allow 0.0.0.0/0 on any port
✗ Never use /0 (all IPs) unless absolutely necessary
```

### 9.2 Document Rules

```
Create a README for your security group:

PORT 443:
  Source: Cloudflare IPs (WAF/DDoS proxy)
  Purpose: HTTPS traffic through Cloudflare
  Updated: 2024-07-22

PORT 80:
  Source: Cloudflare IPs (WAF/DDoS proxy)
  Purpose: HTTP redirect to HTTPS
  Updated: 2024-07-22

PORT 22:
  Source: 203.0.113.5/32 (Ops Team Office)
          203.0.113.6/32 (Ops Team Office)
          198.51.100.25/32 (Admin Remote)
          192.0.2.100/32 (Emergency VPN)
  Purpose: SSH management access
  Updated: 2024-07-22
```

### 9.3 Use Security Group Tags

```
Add tags to your security group:
- Name: "production-ec2-hardened"
- Environment: "production"
- ManagedBy: "Terraform" or "Manual"
- LastAudit: "2024-07-22"
- Owner: "DevOps Team"
```

---

## Part 10: Terraform / IaC Implementation

If using Infrastructure as Code:

### 10.1 Terraform Example

```hcl
resource "aws_security_group" "app" {
  name = "production-app-hardened"
  vpc_id = var.vpc_id

  # Cloudflare IPs on HTTPS
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.cloudflare_ips  # List of CF IPs
  }

  # Cloudflare IPs on HTTP
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.cloudflare_ips
  }

  # Admin IPs on SSH
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.admin_ips  # List of admin IPs
  }

  # Deny everything else (implicit)

  # Allow all outbound
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"  # All protocols
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "production-app-hardened"
    Environment = "production"
    ManagedBy   = "Terraform"
  }
}
```

---

## Part 11: Deployment Checklist

### Pre-Deployment

```
- [ ] Document current security group rules
- [ ] Collect Cloudflare IP ranges (from official source)
- [ ] Collect admin IP list
- [ ] Test application is running on ports 80/443
- [ ] Have AWS console access
- [ ] Have alternative access method (Systems Manager) ready
```

### Deployment Steps

```
1. [ ] Remove old 0.0.0.0/0 rules (don't remove until next step done!)
2. [ ] Add Cloudflare IP rules for port 443
3. [ ] Add Cloudflare IP rules for port 80
4. [ ] Add admin IP rules for port 22
5. [ ] Save all rules
6. [ ] Test access via domain (yourdomain.com)
7. [ ] Test SSH from admin IP
8. [ ] Test direct EC2 IP access (should fail)
```

### Post-Deployment

```
- [ ] Verify all traffic goes through Cloudflare
- [ ] Check CloudFlare Ray ID in response headers
- [ ] Monitor CloudTrail for failed access attempts
- [ ] Document all rules in team wiki/handbook
- [ ] Update runbooks with new access procedures
```

---

## Part 12: Estimated Timeline & Effort

| Task | Time | Effort |
|------|------|--------|
| Collect Cloudflare IPs | 5 min | Trivial |
| Gather admin IP list | 5 min | Trivial |
| Remove old rules | 10 min | Low |
| Add Cloudflare rules | 15 min | Low |
| Add admin SSH rules | 5 min | Low |
| Test all access methods | 20 min | Medium |
| Document rules | 10 min | Low |
| **Total** | **~1 hour** | **Low** |

**Total Implementation Time**: 1 hour of active work

---

## Summary: What Gets Protected

| Threat | Before | After |
|--------|--------|-------|
| Direct EC2 IP attack | ❌ Unprotected | ✅ Blocked by security group |
| Port scanning EC2 | ❌ Responds to scan | ✅ Silent (no response) |
| Unauthorized SSH | ❌ Anyone can try | ✅ Only admin IPs allowed |
| WAF/DDoS bypass | ❌ Possible via direct IP | ✅ Must go through Cloudflare |
| IP enumeration | ❌ EC2 IP public | ✅ Only Cloudflare IPs visible |
| Zero-day in app | ❌ Exposed directly | ✅ Cloudflare WAF catches it first |

---

## Related Documents

- `CLOUDFLARE_WAF_BOT_PROTECTION.md` - Cloudflare edge protection
- `DATABASE_NETWORK_ISOLATION.md` - Database security
- `DEPENDENCY_PATCH_CADENCE.md` - Patch management
- AWS Security Groups documentation: https://docs.aws.amazon.com/vpc/latest/userguide/VPC_SecurityGroups.html

---

## Approval & Sign-Off

| Role | Approval | Date |
|------|----------|------|
| DevOps Lead | — | 2024-07-22 |
| Security Lead | — | 2024-07-22 |
| Tech Lead | — | 2024-07-22 |

---

**Status**: 🟢 Ready for Implementation  
**Roadmap Item**: EC2 security groups & IP masking  
**Implementation Date**: 2024-07-22  
**Last Updated**: 2024-07-22
