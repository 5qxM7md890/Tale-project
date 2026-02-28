# Tale Studio (full-v3)

- Astro 5 + Tailwind v4 UI
- Three.js WebGL canvas (persistent across navigation)
- 7 scroll chapters (hero → featured → capabilities → process → studio → recognition → contact)
- Sound system:
  - click **Sound: Off** to enable (browser autoplay policy)
  - ambient loop + chapter cues (whoosh/chime/impact/tick)
  - WAV files live in `public/sfx/` (procedurally generated, safe to use)

## Local
```bash
npm install
npm run dev
```

## Railway
- Deploy from GitHub
- Start command uses `PORT` and `--allowed-hosts=.up.railway.app`
