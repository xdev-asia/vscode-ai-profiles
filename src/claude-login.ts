export const claudeLoginScript = `
printf '%s\\n' 'Open the login URL printed below in your browser. Return to this terminal and paste the code if prompted.'
"$XDEV_AI_CLI_PATH" auth login --claudeai
login_status=$?
if [ "$login_status" -eq 0 ]; then
  if "$XDEV_AI_CLI_PATH" auth status --text >/dev/null 2>&1; then
    printf '%s\\n' 'Signed in. Opening Claude Code with this xDev AI profile.'
    if [ -n "$XDEV_AI_CLAUDE_QUOTA_SETTINGS" ]; then
      exec "$XDEV_AI_CLI_PATH" --settings "$XDEV_AI_CLAUDE_QUOTA_SETTINGS"
    fi
    exec "$XDEV_AI_CLI_PATH"
  fi
  printf '%s\\n' 'Claude Code did not confirm sign-in for this profile.'
else
  printf '\\nClaude Code sign-in exited with status %s. See the error above.\\n' "$login_status"
fi
printf '%s\\n' 'Retry with: "$XDEV_AI_CLI_PATH" auth login --claudeai' 'Check status with: "$XDEV_AI_CLI_PATH" auth status --text'
exec /bin/sh -i
`;
