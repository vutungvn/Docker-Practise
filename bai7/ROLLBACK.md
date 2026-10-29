# Runbook: Quay lui ShopFast (mục tiêu < 3 phút)

## 1. Khi nào quay lui
- Lỗi 5xx tăng, `/health` trả 503, hoặc lỗi nghiệp vụ nghiêm trọng **ngay sau một lần triển khai**.
- Nguyên tắc: **quay lui trước, điều tra sau**. Không sửa nóng trên production.

## 2. Cách 1 (chuẩn): GitHub Actions, khoảng 1–2 phút

1. Mở **Actions → bai7 Rollback → Run workflow**.
2. **Use workflow from: `main`** (môi trường `production` chỉ cho phép nhánh `main`).
3. Điền:
   - `environment`: `production` (hoặc `staging`)
   - `version`: **để trống** thì về bản chạy ngay trước bản hiện tại. Hoặc dán SHA (đủ 40 ký tự hoặc dạng rút gọn) để về một bản cụ thể.
   - `reason`: link sự cố hoặc mô tả ngắn
4. Với `production`, người trực có quyền phê duyệt bấm **Review deployments → Approve** (rollback cũng phải qua phê duyệt, không có đường tắt).
5. Kiểm tra **Summary** của run: dòng *Now serving* phải là SHA mong muốn. Ghi *Script time* và thời gian job vào bảng ở mục 7.

Rollback và deploy dùng **cùng nhóm concurrency** `bai7-deploy-<env>`. Nếu đang có deploy chạy, rollback sẽ chờ deploy đó kết thúc rồi mới chạy, không bao giờ chạy chồng lên nhau.

## 3. Cách 2 (khẩn cấp): ngay trên server có Docker

Dùng khi GitHub Actions không khả dụng. Áp dụng khi môi trường chạy trên server riêng (self-hosted runner, `DEPLOY_STATE=file`).
```bash
cd Docker-Practise/bai7
export IMAGE=ghcr.io/vutungvn/shopfast-bai7 DB_PASSWORD='<secret của môi trường>' APP_PORT=8082 DEPLOY_STATE=file
bash deploy/rollback.sh production            # về bản trước
bash deploy/rollback.sh production 3f2c1ab    # hoặc về SHA cụ thể
```
Script in ra `rollback finished in Ns` và ghi một dòng vào `~/.shopfast/releases.log`.

## 4. Tìm SHA của bản cần quay về
- Tab **Packages → shopfast-bai7**: mỗi version có thẻ là SHA. Thẻ `production-previous` chính là bản chạy trước bản hiện tại.
- Summary của các run **bai7 CD** trước đó, ở dòng *Now serving*.
- `git log --oneline main`, hoặc `~/.shopfast/releases.log` trên server.

## 5. Rollback làm gì và không làm gì
| | |
|---|---|
| ✅ Đổi container app về image `<sha>` cũ, chờ healthcheck, kiểm tra `/version` | |
| ✅ Tự trả về bản đang chạy nếu bản cũ cũng không healthy | |
| ✅ Cập nhật thẻ con trỏ `production` / `production-previous` | |
| ❌ **Không** chạy migration ngược, **không** xoá dữ liệu | Theo quy tắc expand/contract, schema mới tương thích với code cũ. Image cũ chỉ biết các migration đã chạy rồi, nên bước migrate của nó không làm gì |
| ❌ Không bỏ qua phê duyệt production | |

## 6. Trường hợp đặc biệt
- **Migration lỗi trong lúc deploy:** không cần rollback. Postgres đã huỷ toàn bộ migration lỗi và bản cũ vẫn chạy. Sửa migration bằng một PR mới.
- **Cần khôi phục dữ liệu** (rất hiếm, phải có quyết định của trưởng nhóm, vì mọi dữ liệu ghi sau thời điểm backup sẽ mất): mỗi lần deploy đều tạo backup ở `~/.shopfast/backups/<env>-<thời gian>-before-<sha>.sql.gz` trên máy chạy deploy.
  ```bash
  gunzip -c ~/.shopfast/backups/production-...sql.gz \
    | docker compose -p shopfast-production -f deploy/compose.yml exec -T db psql -U shopfast -d shopfast
  ```
- **Thông báo "another deploy/rollback … is in progress"** mà chắc chắn không có tiến trình nào đang chạy (máy bị tắt đột ngột): xoá `~/.shopfast/<env>.lock` rồi chạy lại.

## 7. Sau khi quay lui
1. Mở PR `git revert <sha lỗi>` vào `develop` rồi lên `main`. Nếu không revert, lần merge tiếp theo vào `main` sẽ đưa lại code lỗi.
2. Ghi lại thời gian:

| Ngày | Môi trường | Từ → về | Lý do | Script time | Thời gian job | Người duyệt |
|---|---|---|---|---|---|---|
| 2026-10-29 | staging (local) | v2 → v1 | e2e test | 9 s | – | – |
| 2026-10-29 | production (local, registry state) | v2 → v1 | kiểm tra chế độ CI | 14 s | – | – |
| | | | | | | |
