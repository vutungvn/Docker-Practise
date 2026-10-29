# Bài 5 – Vá lỗi image 1,4 GB và lộ khoá bí mật (ShopFast)

## Kết quả tóm tắt

| Chỉ số | Trước (`before/Dockerfile`) | Sau (`Dockerfile`) | Yêu cầu |
|---|---|---|---|
| Dung lượng image (`docker images`) | **1,71 GB** (nén: 424 MB) | **199 MB** (nén: 49 MB) | < 250 MB ✅ |
| Build lại sau khi sửa 1 dòng code | **21 s** (chạy lại `npm install` 415 gói) | **2,5 s** (`npm ci` lấy từ cache) | < 20 s ✅ |
| Khoá bí mật trong `docker history` / `inspect` | **Có** (`MatKhau123`, `shopfast-secret-key-2026`) | **Không** | Không ✅ |
| File `.env` nằm trong image | **Có** (`/app/.env`) | Không | – |
| User chạy tiến trình | **root** (uid 0) | **node** (uid 1000), code chỉ đọc | non-root ✅ |
| Lệnh khởi chạy | `npm run start:dev` (ts-node-dev, watch) | `node dist/main.js` | production ✅ |
| Số tiến trình / RAM lúc idle | 4 tiến trình / 75 MiB | 1 tiến trình / 16 MiB | – |

Số liệu đo trên Docker Desktop 28.3.3 (Windows, containerd image store). Log đầy đủ: [before/evidence-output.txt](before/evidence-output.txt).

---

## 1. Phân tích nghiệp vụ

**Quy tắc đúng:** image production chỉ chứa những gì cần để **chạy**:

| Được phép có | Không được có |
|---|---|
| Node runtime tối thiểu | Mã nguồn TypeScript (`src/*.ts`), test, tsconfig |
| JS đã biên dịch (`dist/`) | `devDependencies` (typescript, jest, ts-node-dev…) |
| `dependencies` production (express) | Khoá bí mật (ENV, file `.env`, lịch sử tầng) |
| `package.json` | Quyền root khi chạy |

**Tác động hiện tại:**

| Bên liên quan | Vấn đề | Nguyên nhân gốc |
|---|---|---|
| Đội hạ tầng | Image 1,4–1,7 GB, mất 6 phút tải mỗi lần deploy | Base `node:20` bản Debian đầy đủ, image một tầng build chứa cả công cụ build lẫn devDeps |
| Đội phát triển | Mỗi lần sửa 1 dòng phải chờ `npm install` lại | `COPY . .` đặt trước `RUN npm install` nên cache tầng bị vô hiệu |
| Đội bảo mật | Mật khẩu DB và JWT secret công khai | `ENV` cố định lúc build được lưu vào metadata image, ai `docker pull` được image cũng đọc được |
| Vận hành | Tiến trình chạy root, chế độ dev/watch, `NODE_ENV` không đặt | `CMD npm run start:dev`, không có `USER` |

> ⚠️ **Lưu ý nghiệp vụ quan trọng:** sửa Dockerfile **không** xoá khoá khỏi các image cũ đã công khai. Bắt buộc phải: (1) **đổi mật khẩu DB và JWT secret ngay**, vì mọi token JWT ký bằng khoá cũ đều phải coi là không còn tin cậy; (2) xoá các tag image cũ khỏi registry; (3) từ nay chỉ truyền khoá lúc chạy (`--env-file`, Docker/K8s secrets, Vault…).

---

## 2. Phần 1 – Các khiếm khuyết và bằng chứng

Tái hiện toàn bộ bằng chứng: `bash scripts/evidence-before.sh`

### Lỗi 1 – Khoá bí mật cố định bằng `ENV` lúc build (nghiêm trọng nhất)
```bash
$ docker history --no-trunc shopfast:before | grep -oE '(DATABASE_URL|JWT_SECRET)=[^ ]+'
JWT_SECRET=shopfast-secret-key-2026
DATABASE_URL=postgres://admin:MatKhau123@db:5432/shopfast

$ docker image inspect shopfast:before --format '{{range .Config.Env}}{{println .}}{{end}}'
DATABASE_URL=postgres://admin:MatKhau123@db:5432/shopfast
JWT_SECRET=shopfast-secret-key-2026
```
Bản thân BuildKit cũng cảnh báo: `SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data`.

### Lỗi 2 – `COPY . .` không có `.dockerignore`: chép cả `.env`, test, script, `node_modules` của máy host vào image
```bash
$ docker run --rm --entrypoint cat shopfast:before /app/.env
DATABASE_URL=postgres://admin:MatKhau123@db:5432/shopfast
JWT_SECRET=shopfast-secret-key-2026

$ docker run --rm --entrypoint ls shopfast:before -A /app
.dockerignore .env .env.example .gitignore Dockerfile before dist node_modules
package-lock.json package.json scripts src test tsconfig.json
```
Khi build trên máy dev Windows (có sẵn `node_modules`), `node_modules` của host bị chép đè vào image Linux và **build hỏng**:
```
/app/node_modules/.bin/tsc: 33: exec: node.exe: not found
ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 127
```

### Lỗi 3 – Thứ tự lệnh phá cache: sửa 1 dòng code thì `npm install` chạy lại toàn bộ
```
#6 [3/5] COPY . .            <- source đổi, tầng này mất cache
#7 [4/5] RUN npm install     <- kéo theo cài lại
#7 16.27 added 415 packages, and audited 416 packages in 16s
Rebuild after 1-line change: 21s
```
Với dự án thật có hàng trăm phụ thuộc và mạng CI chậm hơn, con số này lên tới vài phút.

### Lỗi 4 – Base image `node:20` (Debian đầy đủ, có gcc, python, git…) quá nặng
```
shopfast:before   1.71GB
node:20           1.58GB     <- 92% dung lượng là base image
node:20-alpine    193MB
```

### Lỗi 5 – Một stage duy nhất: image production chứa mã TypeScript và devDependencies
```bash
$ docker run --rm --entrypoint sh shopfast:before -c 'find /app/src /app/test -name "*.ts"'
/app/src/app.ts  /app/src/config.ts  /app/src/main.ts  /app/test/app.spec.ts
$ ... du -sh /app/node_modules; ls /app/node_modules | wc -l
79M   307 package    (có typescript, jest, ts-node-dev)
```
Bản production chỉ cần 4,75 MB `node_modules` (express và các phụ thuộc của nó).

### Lỗi 6 – `npm install` thay vì `npm ci`
`npm install` có thể sửa `package-lock.json` và cài phiên bản khác nhau giữa các lần build, nên build không tái lập được, đồng thời luôn cài cả `devDependencies`.

### Lỗi 7 – Container chạy bằng root
```bash
$ docker run --rm --entrypoint id shopfast:before
uid=0(root) gid=0(root) groups=0(root)
$ docker image inspect shopfast:before --format 'User="{{.Config.User}}"'
User=""
```
Nếu ứng dụng bị khai thác RCE, kẻ tấn công có root trong container và có thể ghi đè chính mã nguồn.

### Lỗi 8 – Lệnh khởi chạy là của môi trường dev
```
$ docker exec sf-before ps -o pid,user,rss,args
  1 root  53440 npm run start:dev
 18 root   1440 sh -c ts-node-dev --respawn --transpile-only src/main.ts
 19 root  90228 node /app/node_modules/.bin/ts-node-dev ...
 26 root  51684 /usr/local/bin/node -r /tmp/ts-node-dev-hook-...js ... src/main.ts
NODE_ENV=<unset>      RAM 75.41MiB
```
Dev chạy 4 tiến trình, biên dịch TS lúc runtime, theo dõi file (watch), `NODE_ENV` không phải `production` (Express bật chế độ debug, không cache view…). Bước `npm run build` tạo ra `dist/` nhưng **không hề được dùng**.

### Lỗi 9 – Không có `HEALTHCHECK`, không xử lý tín hiệu dừng
Orchestrator không biết app sống hay chết; `npm` làm PID 1 là lớp trung gian không cần thiết giữa Docker và app.

---

## 3. Phần 2 – Dockerfile đã sửa

Xem [Dockerfile](Dockerfile) và [.dockerignore](.dockerignore).

| Lỗi | Cách sửa |
|---|---|
| 1. Secret trong ENV | Xoá hoàn toàn; truyền lúc chạy bằng `--env-file .env`. App kiểm tra và **thoát mã 1** nếu thiếu ([src/config.ts](src/config.ts)) |
| 2. `COPY . .` | `.dockerignore` loại `node_modules`, `.env*`, `.git`, `test`…; chỉ `COPY` đúng file cần |
| 3. Cache | `COPY package*.json` → `npm ci` **trước**, rồi mới `COPY src`; thêm `--mount=type=cache` cho `~/.npm` |
| 4. Base nặng | `node:20-alpine` |
| 5. Một stage | 3 stage: `deps` (prod deps) → `build` (tsc) → `runtime` (chỉ `dist` + prod `node_modules`) |
| 6. `npm install` | `npm ci` (theo đúng lockfile), `--omit=dev` cho runtime |
| 7. Root | `USER node`; file thuộc root nên app **không ghi đè được code** |
| 8. Lệnh dev | `CMD ["node", "dist/main.js"]`, `NODE_ENV=production` |
| 9. Healthcheck/tín hiệu | `HEALTHCHECK` gọi `/health`; app tự xử lý `SIGTERM` để tắt êm |

Các tầng của image mới:
```
0B      CMD ["node" "dist/main.js"]
0B      HEALTHCHECK ... wget -qO- http://127.0.0.1:3000/health
0B      USER node
12.3kB  COPY package.json ./
24.6kB  COPY /app/dist ./dist
4.75MB  COPY /app/node_modules ./node_modules
0B      ENV NODE_ENV=production PORT=3000
```

### Cách chạy
```bash
cp .env.example .env              # điền giá trị thật, .env không vào git và không vào image
docker build -t shopfast:after .
docker run -d --name shopfast -p 3000:3000 --env-file .env shopfast:after
curl http://localhost:3000/health
```

---

## 4. Testcase

Chạy toàn bộ: `bash scripts/verify-after.sh` (Git Bash / Linux / macOS, cần file `.env`). Mã thoát = số testcase fail.

| ID | Tiêu chí | Bước kiểm tra | Kỳ vọng | Kết quả |
|---|---|---|---|---|
| TC01 | Build | `docker build --no-cache -t shopfast:after .` | Thành công (17 s) | ✅ |
| TC02 | Dung lượng | `docker images shopfast:after` | < 250 MB → **199 MB** | ✅ |
| TC03 | Cache | Build lại không đổi gì | < 10 s → **0,9 s** | ✅ |
| TC04 | Cache | Sửa 1 dòng `src/app.ts` rồi build lại | < 20 s → **2,5 s** | ✅ |
| TC05 | Cache | Log build sau khi sửa code | Không có `added N packages` (npm ci CACHED) | ✅ |
| TC06 | Bí mật | `docker history --no-trunc \| grep -E 'MatKhau123\|shopfast-secret-key-2026\|DATABASE_URL\|JWT_SECRET'` | Không tìm thấy | ✅ |
| TC07 | Bí mật | `docker image inspect --format '{{json .Config.Env}}'` | Không có `DATABASE_URL`/`JWT_SECRET` | ✅ |
| TC08 | Bí mật | `docker export <container> \| grep -a` toàn bộ filesystem | Không chứa giá trị secret | ✅ |
| TC09 | Nội dung | `ls -A /app` | Chỉ `dist node_modules package.json` | ✅ |
| TC10 | Nội dung | Tìm `*.ts`, `.env`, `*.spec.*` trong `/app` | Không có | ✅ |
| TC11 | Nội dung | Kiểm tra `node_modules/{typescript,jest,ts-node-dev}` | Không tồn tại | ✅ |
| TC12 | User | `docker run --rm --entrypoint id shopfast:after -u` | ≠ 0 → **1000 (node)** | ✅ |
| TC13 | User | `touch /app/dist/main.js` với user app | Bị từ chối (Permission denied) | ✅ |
| TC14 | Lệnh chạy | `inspect .Config.Cmd` | `["node","dist/main.js"]` | ✅ |
| TC15 | Lệnh chạy | `inspect .Config.Env` | Có `NODE_ENV=production` | ✅ |
| TC16 | Âm tính | `docker run` **không** truyền secret | Container thoát mã 1, log `Missing required environment variables: DATABASE_URL, JWT_SECRET` | ✅ |
| TC17 | Chức năng | `docker run --env-file .env` → `GET /health` | HTTP 200, `"status":"ok"` | ✅ |
| TC18 | Bí mật | Nội dung `/health` | Không chứa giá trị secret | ✅ |
| TC19 | Chức năng | `GET /products` | Trả danh sách sản phẩm | ✅ |
| TC20 | Lệnh chạy | `docker exec ps` | PID 1 = `node dist/main.js`, user `node`, chỉ 1 tiến trình | ✅ |
| TC21 | Vận hành | `inspect .State.Health.Status` | `healthy` | ✅ |
| TC22 | Vận hành | `docker stop` | < 5 s, exit 0, log `received SIGTERM` (0,4 s) | ✅ |

Unit test của ứng dụng (chạy trên host): `npm ci && npm test` → 3/3 pass.

### Kiểm tra nhanh bằng tay (PowerShell / CMD)
```powershell
docker images shopfast
docker history --no-trunc shopfast:after | findstr /i "MatKhau123 shopfast-secret-key JWT_SECRET DATABASE_URL"   # không ra gì
docker history --no-trunc shopfast:before | findstr /i "MatKhau123"                                              # ra khoá -> lỗi cũ
docker run --rm --entrypoint id shopfast:after
docker image inspect shopfast:after --format "{{.Config.User}} {{json .Config.Cmd}}"
```

## Cấu trúc thư mục
```
bai5/
├── Dockerfile                  # bản đã sửa
├── .dockerignore
├── .env.example                # mẫu biến môi trường (không chứa giá trị thật)
├── before/
│   ├── Dockerfile              # bản gốc lỗi, giữ để đo bằng chứng
│   ├── Dockerfile.dockerignore # rỗng, tái hiện việc không có .dockerignore
│   └── evidence-output.txt     # output của scripts/evidence-before.sh
├── scripts/
│   ├── lib.sh
│   ├── evidence-before.sh      # Phần 1: thu thập bằng chứng
│   └── verify-after.sh         # Phần 2: 22 testcase tự động
├── src/                        # app Express + TypeScript
└── test/app.spec.ts            # unit test (jest + supertest)
```
