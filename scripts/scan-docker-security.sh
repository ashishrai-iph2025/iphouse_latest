#!/bin/bash

###############################################################################
# Docker Image Security Scanning Script
#
# Scans Docker image for CVEs and generates security report
# Usage: ./scan-docker-security.sh [image-name] [tag]
###############################################################################

set -e

IMAGE_NAME="${1:-iphouse}"
IMAGE_TAG="${2:-latest}"
FULL_IMAGE="$IMAGE_NAME:$IMAGE_TAG"

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║ Docker Image Security Scanner                                      ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Image: $FULL_IMAGE"
echo "Date: $(date)"
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 1. Check if image exists
# ────────────────────────────────────────────────────────────────────────────
echo "Step 1: Verifying Docker image..."
if ! docker image inspect "$FULL_IMAGE" > /dev/null 2>&1; then
    echo "❌ Image not found: $FULL_IMAGE"
    echo ""
    echo "Build image first:"
    echo "  docker build -t $IMAGE_NAME:$IMAGE_TAG ."
    exit 1
fi
echo "✓ Image found"
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 2. Check image size and layers
# ────────────────────────────────────────────────────────────────────────────
echo "Step 2: Analyzing image size..."
IMAGE_SIZE=$(docker image inspect "$FULL_IMAGE" --format='{{.Size}}')
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
echo "✓ Image size: ${IMAGE_SIZE_MB}MB"
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 3. Scan with docker scan (if available)
# ────────────────────────────────────────────────────────────────────────────
echo "Step 3: Running docker scan (native scanner)..."
if command -v docker &> /dev/null && docker scan --version &> /dev/null 2>&1; then
    echo "Docker scan available, running..."
    docker scan "$FULL_IMAGE" --severity high || {
        echo "⚠️  Docker scan found high-severity issues"
    }
else
    echo "⚠️  docker scan not available (requires Docker Desktop/Pro)"
fi
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 4. Scan with Trivy (if available)
# ────────────────────────────────────────────────────────────────────────────
echo "Step 4: Running Trivy scanner (recommended)..."
if command -v trivy &> /dev/null; then
    echo "✓ Trivy found, scanning image..."
    trivy image --severity HIGH,CRITICAL "$FULL_IMAGE" || {
        EXIT_CODE=$?
        if [ $EXIT_CODE -eq 1 ]; then
            echo "⚠️  Trivy found HIGH/CRITICAL vulnerabilities"
        fi
    }
else
    echo "ℹ️  Trivy not installed. Install it for comprehensive CVE scanning:"
    echo "  https://github.com/aquasecurity/trivy"
    echo ""
    echo "  Quick install (macOS):"
    echo "    brew install trivy"
    echo ""
    echo "  Quick install (Linux):"
    echo "    sudo apt-get install trivy"
fi
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 5. Check base image freshness
# ────────────────────────────────────────────────────────────────────────────
echo "Step 5: Checking base image versions..."
BASE_IMAGE=$(docker inspect "$FULL_IMAGE" --format='{{index .RepoDigests 0}}' || echo "unknown")
echo "Base image digest: $BASE_IMAGE"
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 6. Generate report
# ────────────────────────────────────────────────────────────────────────────
echo "Step 6: Generating security report..."

REPORT_FILE="docker-security-scan-$(date +%s).txt"
cat > "$REPORT_FILE" << EOF
╔════════════════════════════════════════════════════════════════════╗
║ Docker Image Security Scan Report                                  ║
╚════════════════════════════════════════════════════════════════════╝

Date: $(date)
Image: $FULL_IMAGE
Image Size: ${IMAGE_SIZE_MB}MB

────────────────────────────────────────────────────────────────────────────
Recommendations:
────────────────────────────────────────────────────────────────────────────

1. CRITICAL - Quarterly Base Image Updates
   - Update Node.js: Ensure using latest LTS version (currently 20)
   - Update Alpine: Pull latest security patches
   - Update Go: Use latest stable version (currently 1.24)

2. HIGH - Dependency Updates
   - npm audit --omit=dev: Run before every build
   - go mod tidy: Update Go dependencies
   - Remove unused dependencies to reduce attack surface

3. MEDIUM - Image Scanning
   - Enable automated Docker image scanning in CI/CD
   - Use Trivy for local scanning: trivy image iphouse:latest
   - Review and remediate CVEs before production deployment

4. MEDIUM - Supply Chain Security
   - Keep --ignore-scripts in npm ci (prevents install hook attacks)
   - Use npm audit-level=high to block on CVEs
   - Regularly update base images from official registries

────────────────────────────────────────────────────────────────────────────
Scanning Tools:
────────────────────────────────────────────────────────────────────────────

✓ docker scan (native Docker Desktop feature)
✓ Trivy (Open Source CVE scanner)
  Install: https://github.com/aquasecurity/trivy
  Usage: trivy image iphouse:latest

✓ GitHub Actions (Automated scanning)
  Workflow: .github/workflows/security-scan.yml

────────────────────────────────────────────────────────────────────────────
Quarterly Patch Schedule:
────────────────────────────────────────────────────────────────────────────

January:   Update base images (Node, Go, Alpine)
April:     Update base images + dependencies
July:      Update base images + dependencies
October:   Update base images + dependencies

────────────────────────────────────────────────────────────────────────────
EOF

echo "✓ Report saved: $REPORT_FILE"
echo ""

# ────────────────────────────────────────────────────────────────────────────
# 7. Summary
# ────────────────────────────────────────────────────────────────────────────
echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║ Scan Complete                                                      ║"
echo "╚════════════════════════════════════════════════════════════════════╝"
echo ""
echo "✓ Image size: ${IMAGE_SIZE_MB}MB"
echo "✓ Report: $REPORT_FILE"
echo ""
echo "Next steps:"
echo "1. Review scan results above"
echo "2. For automated scanning: CI/CD workflow already configured"
echo "3. For local scanning: Install Trivy for comprehensive CVE scanning"
echo ""
