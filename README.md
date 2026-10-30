# rig

Keeps a lane's lights on while nobody is in it: a heartbeat every minute, a status board, and
(next) a morning digest of what ran overnight.

```sh
cp .env.example .env   # set LANE_MARKER
pnpm install
pnpm dev               # http://localhost:8787
```

Working on it with an agent: start at [AGENTS.md](AGENTS.md).

Export the sample digest through HTTP to an HTML file outside every Git working tree:

```sh
pnpm preview:export --out /tmp/rig-preview --marker false
# For the marked review copy, supply LANE_MARKER in the environment:
pnpm preview:export --out /tmp/rig-preview-marked --marker true
```

The command starts and stops its own server, uses the checked-in sample runs, and never loads
`.env`. Marked mode requires a nonempty `LANE_MARKER`; cleanup mode clears it even if inherited.
Review the generated `index.html` locally before publishing. Never commit the export.

After explicit approval for publication, configure GitHub Pages to use GitHub Actions and set
the `LANE_MARKER` Actions secret for the marked copy. Manually run **Publish digest preview**
with `include_marker: true`. It validates the code, exports to runner temporary storage and
deploys only the HTML folder, with artifact retention of one day. It never runs on a push.
After review and separate approval for cleanup publication, run it with `include_marker: false`
to replace the same Pages URL without the marker; remove the marked run's retained artifact.

Workflow references: [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
and [Pages artifact upload](https://github.com/actions/upload-pages-artifact).
