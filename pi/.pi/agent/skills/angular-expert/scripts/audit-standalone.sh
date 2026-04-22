#!/usr/bin/env bash
# Angular Standalone Audit Script
# Scans a project for NgModule usage and lists files needing migration.

echo "=== Angular Standalone Audit ==="
echo ""

MODULE_COUNT=$(grep -rl "@NgModule" --include="*.ts" . 2>/dev/null | wc -l)
COMPONENT_COUNT=$(grep -rl "standalone: true" --include="*.ts" . 2>/dev/null | wc -l)

echo "NgModule files found: $MODULE_COUNT"
echo "Standalone components found: $COMPONENT_COUNT"
echo ""

if [ "$MODULE_COUNT" -gt 0 ]; then
  echo "Files with @NgModule:"
  grep -rl "@NgModule" --include="*.ts" .
  echo ""
  echo "Next steps:"
  echo "1. Review references/ngmodule-to-standalone-migration.md"
  echo "2. Start with leaf components (lowest dependency count)"
  echo "3. Run this script again to verify progress"
else
  echo "No @NgModule found. Migration likely complete."
fi
