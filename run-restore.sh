#!/bin/bash
# Run by cron at 08:30 and 10:00. Output goes to logs/restore.log.

PROJECT_DIR=/home/ubunto-test/restore-odoo
export NVM_DIR=/home/ubunto-test/.nvm

LOG_FILE="$PROJECT_DIR/logs/restore.log"

mkdir -p "$PROJECT_DIR/logs"
# Show output on screen as well when run by hand. Cron has no terminal, so it only logs.
if [ -t 1 ]; then
  exec > >(tee -a "$LOG_FILE") 2>&1
else
  exec >> "$LOG_FILE" 2>&1
fi

echo "===== $(date '+%F %T') start ====="
. "$NVM_DIR/nvm.sh"
nvm use 26 || { echo "nvm use 26 failed"; exit 1; }

cd "$PROJECT_DIR" || exit 1
npx playwright test --reporter=list
status=$?
echo "===== $(date '+%F %T') finished with exit code $status ====="
exit $status
