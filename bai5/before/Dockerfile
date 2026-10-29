# Dockerfile - build duoc, chay duoc, nhung sai nhieu cho
# (Ban goc giu nguyen de do bang chung. Build tu thu muc bai5:
#   docker build -f before/Dockerfile -t shopfast:before .)
FROM node:20

WORKDIR /app

COPY . .

RUN npm install

ENV DATABASE_URL=postgres://admin:MatKhau123@db:5432/shopfast
ENV JWT_SECRET=shopfast-secret-key-2026

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
