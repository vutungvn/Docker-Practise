# Bài 6 – Điền khuyết pipeline CI/CD bị thiếu bước bảo vệ (ShopFast)

Workflow: [`.github/workflows/bai6-cicd.yml`](../.github/workflows/bai6-cicd.yml)
(GitHub chỉ đọc workflow ở `.github/workflows/` tại gốc repo, nên file nằm ngoài thư mục `bai6/` và dùng `working-directory: bai6`.)

## 1. Nghiệp vụ

**Quy tắc đúng**

| # | Quy tắc | Workflow cũ | Hậu quả đã xảy ra |
|---|---|---|---|
| R1 | Chỉ mã đã qua kiểm thử mới được đóng gói | Không có bước test, build ngay sau `npm install` | Code lỗi vẫn thành image |
| R2 | Chỉ nhánh chính mới được đẩy image | `on: push` + push vô điều kiện, **mọi nhánh** đều đẩy `latest` | Nhánh làm dở ghi đè `latest`, bị deploy ra production, **sự cố 45 phút** |
| R3 | Khoá bí mật không nằm trong tệp cấu hình | `docker login -p MatKhauCuaToi123` | Ai đọc được repo (và log) đều có mật khẩu registry |
| R4 | Mỗi bản build phải có định danh cố định | Chỉ có thẻ `latest` | Có sự cố cũng không biết bản trước là bản nào để quay lui |
| R5 | Pipeline phải nhanh | `npm install` cài từ đầu mỗi lần | **8 phút**/lần chạy |

> ⚠️ Mật khẩu `MatKhauCuaToi123` đã nằm trong lịch sử git, nên phải coi là **đã lộ** và **đổi ngay** trên registry. Xoá dòng đó khỏi file không làm nó biến mất khỏi các commit cũ.

## 2. Năm chỗ khuyết đã điền

| Chỗ | Trước | Sau |
|---|---|---|
| **(1) Bộ nhớ đệm** | `npm install` mỗi lần | `actions/setup-node` với `cache: npm` (khoá theo hash của `package-lock.json`) + `npm ci`. Thêm cache tầng Docker `cache-from/cache-to: type=gha` |
| **(2) Kiểm thử là điều kiện tiên quyết** | Không có | Job `test` chạy build TypeScript, unit test và integration test. Job `build-and-push` có `needs: test`, nên test fail thì job đóng gói bị **skip** |
| **(3) Khoá bí mật** | `-p MatKhauCuaToi123` | `docker/login-action` với `password: ${{ secrets.GITHUB_TOKEN }}`: token ngắn hạn GitHub tự cấp cho từng lần chạy, hết hạn khi job xong. `permissions` tối thiểu (`packages: write` chỉ cấp cho job push) |
| **(4) Chỉ nhánh chính** | Push mọi nhánh | Bước `Log in` và `Push` có `if: github.ref == 'refs/heads/main'`. Nhánh phụ vẫn **build** image để kiểm tra Dockerfile nhưng **không đăng nhập, không đẩy** |
| **(5) Thẻ theo commit** | Chỉ `latest` | Hai thẻ: `:<commit-sha>` (bất biến, dùng để quay lui) và `:latest`. Thêm nhãn `org.opencontainers.image.revision` |

### Bẫy dữ liệu đã xử lý
- **Integration test cần Postgres + Redis:** job `test` khai báo `services:` gồm `postgres:16-alpine` và `redis:7-alpine`, có healthcheck nên test chỉ bắt đầu khi hai dịch vụ đã sẵn sàng. Postgres dùng `trust` auth vì đây là container dùng một lần, chỉ sống trong job, nên **không có mật khẩu nào trong file**.
- **Chỉ có `latest` thì không quay lui được:** mỗi lần build trên main có thêm thẻ SHA. Quay lui:
  ```bash
  docker pull ghcr.io/vutungvn/shopfast-api:<sha-cua-commit-truoc>
  ```

## 3. Ứng dụng dùng để kiểm thử

API Express + TypeScript ([src/](src/)):
- `GET /health`: kiểm tra Postgres (`SELECT 1`) và Redis (`PING`). Trả 200 nếu cả hai up, 503 nếu một trong hai down.
- `GET /products`: cache-aside. Lần đầu đọc từ Postgres (`X-Cache: MISS`) rồi lưu vào Redis. Những lần sau đọc từ Redis (`X-Cache: HIT`).
- `POST /products`: kiểm tra dữ liệu đầu vào, ghi vào Postgres, xoá cache.

| Loại | File | Nội dung |
|---|---|---|
| Unit (9 test) | [test/unit/](test/unit/) | Validate dữ liệu sản phẩm, đọc cấu hình |
| Integration (4 test) | [test/integration/api.spec.ts](test/integration/api.spec.ts) | `/health` thấy DB + Redis up; cache MISS → HIT; POST ghi DB và xoá cache; dữ liệu sai bị từ chối mà không ghi DB |

Chạy ở máy local:
```bash
cd bai6
npm ci
docker compose up -d --wait db redis        # Postgres :15432, Redis :16379
cp .env.example .env                        # hoặc export 2 biến bên dưới
DATABASE_URL=postgres://postgres@localhost:15432/shopfast REDIS_URL=redis://localhost:16379 npm test
docker compose up -d --build --wait         # chạy cả API ở http://localhost:3000
docker compose down -v
```

## 4. Testcase theo tiêu chí đánh giá

Nên làm **theo đúng thứ tự** dưới đây: cache tạo trên `main` dùng được cho mọi nhánh, còn cache tạo trên nhánh phụ thì `main` không dùng được.

| ID | Tiêu chí | Cách làm | Kỳ vọng (chụp ảnh) |
|---|---|---|---|
| TC1 | Main: đẩy image với 2 thẻ | Push lên `main` | Cả 2 job xanh. Bước `Push image (main only)` chạy. Summary ghi `Pushed: …:<sha> and …:latest`. Package `shopfast-api` xuất hiện ở tab **Packages** với 2 thẻ |
| TC2 | Lần chạy thứ 2 nhanh hơn | Actions → chọn run TC1 → **Re-run all jobs** (hoặc push thêm 1 commit) | Log `setup-node`: lần 1 là `Cache not found…`, lần 2 là `Cache restored from key: node-cache-…`. Bước `Build image` hiện nhiều `CACHED`. So sánh thời gian bước `Install dependencies` và `Build image` của hai lần |
| TC3 | Nhánh phụ: test chạy, không đẩy | `git switch -c feature/demo`, sửa 1 dòng trong `bai6/`, push | Job `test` xanh. Trong job `build-and-push`: `Build image` chạy, còn `Log in to GHCR` và `Push image` hiện **skipped**. Summary ghi `Not pushed`. Tab Packages **không** có thẻ mới |
| TC4 | Test fail thì không đóng gói | Trên nhánh `feature/broken-test`, sửa `expect(res.status).toBe(200)` thành `201` trong `test/integration/api.spec.ts`, push | Job `test` đỏ ở bước `Integration tests`. Job `build-and-push` **skipped** (xám), không build, không push |
| TC5 | Không có khoá dạng văn bản thuần | `grep -nEi "password\|passwd\|-p \|token" .github/workflows/bai6-cicd.yml` | Chỉ thấy `password: ${{ secrets.GITHUB_TOKEN }}`, không có giá trị thật nào |

Nếu không muốn sửa code chỉ để kích hoạt chạy (workflow chỉ chạy khi `bai6/**` hoặc file workflow thay đổi), vào **Actions → CI/CD → Run workflow** và chọn nhánh.

### Lệnh chạy demo
```bash
# TC1 + TC2 (main)
git add .github bai6 && git commit -m "feat(bai6): CI/CD pipeline" && git push
# -> Actions: chờ xanh, chụp ảnh; bấm Re-run all jobs, chụp ảnh lần 2

# TC3 (nhánh phụ)
git switch -c feature/demo
echo "" >> bai6/README.md && git commit -am "chore: demo branch run" && git push -u origin feature/demo

# TC4 (test fail)
git switch -c feature/broken-test main
sed -i "s/expect(res.status).toBe(200);/expect(res.status).toBe(201);/" bai6/test/integration/api.spec.ts
git commit -am "test: intentionally broken" && git push -u origin feature/broken-test

# Dọn dẹp
git switch main
git push origin --delete feature/demo feature/broken-test
git branch -D feature/demo feature/broken-test
```

## Cấu trúc
```
.github/workflows/bai6-cicd.yml   # pipeline đã điền 5 chỗ khuyết
bai6/
├── Dockerfile                    # multi-stage, alpine, non-root (như bài 5)
├── docker-compose.yml            # Postgres + Redis (+ API) để chạy local
├── src/                          # app, config, db, products (cache-aside), validation
└── test/{unit,integration}/
```
