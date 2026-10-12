# FF 서버 관리 (Cloudflare Worker)
1. `cd web-admin && npx wrangler kv namespace create KV` → 출력된 id 를 wrangler.toml 에 붙여넣기
2. `npx wrangler deploy` → 나온 주소(https://ff-admin.xxx.workers.dev) 접속, 비밀번호 `1102`
3. 서버 `plugins/FFPlugin/config.yml` 의 `web.url` 에 그 주소, `web.key` 에 wrangler.toml 의 SERVER_KEY 와 같은 값 → 서버 재시작
(비밀번호/키는 `npx wrangler secret put ADMIN_PASSWORD`, `SERVER_KEY` 로 옮기면 더 안전)
