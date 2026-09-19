# Watching a session

Nothing is installed into `~/.claude/settings.json`. A session is watched only when
you start it with this hook's settings file.

1. Tell the hook where the Worker is. Create `~/.config/jev-sscope/client.env`
   (mode 600) with:

   ```
   WORKER_URL=http://localhost:8787
   INGEST_TOKEN=<same value as INGEST_TOKEN in the Worker's .dev.vars>
   ```

2. Generate `settings.json` once (it contains the absolute path of `hook.py` and of
   the Python that runs it, so it is not committed):

   ```sh
   python3 client/hook.py --write-settings
   ```

3. Start the session you want to watch, from any repository:

   ```sh
   claude --settings /absolute/path/to/jev-sscope/client/settings.json
   ```

The hook runs in the background, prints nothing, and gives up after 3 seconds. If the
Worker is down the session does not notice. Steps taken inside subagents are not sent.

Optional environment variables: `JEV_SSCOPE_LOG=<file>` appends one timing line per
event; `JEV_SSCOPE_WORKER_URL` overrides the Worker address for one session (localhost,
127.0.0.1 and 192.0.2.x only); `JEV_SSCOPE_RELAX_TLS=1` drops Python's strict RFC 5280
flag for hosts behind a TLS-intercepting proxy (chain and host name still verified).
