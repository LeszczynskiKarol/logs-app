# ============================================

# SETUP: Stojan Logs — własny agregator logów

# ============================================

# Kolejność: DNS → App → PM2 → Nginx → SSL → Vector → Test

# ============================================

# KROK 1: DNS — dodaj subdomenę logs

# ============================================

# W AWS Console → Route 53 → domena → Create Record:

# Name: logs

# Type: A

# Value: IP DOMENY

# TTL: 300

# ============================================

# KROK 2: Skopiuj projekt na serwer

# ============================================

# Na lokalu (Git Bash):

cd /d/
git clone <ten-projekt> logs-app

# Albo skopiuj pliki ręcznie na serwer:

scp -r -i ~/.ssh/[KLUCZ].pem logs-app/ ec2-user@[IP]:/home/ec2-user/logs-app/

# ============================================

# KROK 3: Setup na instancji EC2 (SSH)

# ============================================

ssh -i ~/.ssh/[KLUCZ].pem ec2-user@[IP]

cd /home/ec2-user/logs-app
npm install

# Zmień klucze! (edytuj .env albo ustaw w PM2)

# Wygeneruj losowy klucz:

echo "LOG_INGEST_KEY=$(openssl rand -hex 16)" 
echo "LOG_ADMIN_PASS=$(openssl rand -hex 8)"

# Uruchom przez PM2

pm2 start src/server.js \
 --name stojan-logs \
 --env LOG_PORT=4100 \
 --env LOG_INGEST_KEY="WKLEJ_KLUCZ_Z_OPENSSL" \
 --env LOG_ADMIN_USER="admin" \
 --env LOG_ADMIN_PASS="WKLEJ_HASLO_Z_OPENSSL"

# Sprawdź

pm2 logs stojan-logs --lines 5 --nostream

# Powinno: 📋 Log server running on http://0.0.0.0:4100

# Zapisz PM2 config (przetrwa reboot)

pm2 save

# ============================================

# KROK 4: Nginx — subdomena

# ============================================

sudo cp /home/ec2-user/logs-app/logs.[DOMENA].conf /etc/nginx/conf.d/
sudo nginx -t
sudo systemctl reload nginx

# Test (HTTP):

curl -s http://logs.[DOMENA]/api/stats -u admin:TWOJE_HASLO

# ============================================

# KROK 5: SSL — certbot

# ============================================

# Jeśli masz certbot:

sudo certbot --nginx -d logs.[DOMENA]

# Jeśli nie masz certbot:

sudo yum install -y certbot python3-certbot-nginx
sudo certbot --nginx -d logs.[DOMENA]

# ============================================

# KROK 6: Vector — przekieruj na lokalne API

# ============================================

# Podmień config Vectora:

sudo cp /home/ec2-user/logs-app/vector.yaml /etc/vector/vector.yaml

# ⚠️ WAŻNE: zmień klucz w vector.yaml na ten sam co LOG_INGEST_KEY!

sudo nano /etc/vector/vector.yaml

# Zmień: x-api-key: "zmien-ten-klucz-2026" → x-api-key: "TWOJ_KLUCZ"

sudo systemctl restart vector

# ============================================

# KROK 7: Test

# ============================================

# Wyślij testowy log:

curl -X POST http://localhost:4100/ingest \
 -H "Content-Type: application/json" \
 -H "x-api-key: TWOJ_KLUCZ" \
 -d '{"message":"Test log from setup","host":"manual-test","level":"info"}'

# Sprawdź dashboard:

# Otwórz: https://logs.[DOMENA]

# Login: admin / TWOJE_HASLO

# ============================================

# PÓŹNIEJ: Dodawanie zdalnych instancji

# ============================================

# Na każdej zdalnej instancji:

# 1. Zainstaluj Vector (yum install / apt install)

# 2. Skopiuj vector-remote.yaml jako /etc/vector/vector.yaml

# 3. Zmień x-api-key na ten sam klucz

# 4. Zmień ścieżki logów jeśli inne (ubuntu vs ec2-user)

# 5. sudo systemctl restart vector

#

# ⚠️ Security Group zdalnych instancji musi pozwalać

# na outbound HTTP/HTTPS do 16.171.6.205:80/443

# (domyślnie outbound jest otwarty, więc powinno działać)

#

# ⚠️ Security Group Stojana musi mieć port 80/443

# otwarty na inbound (już ma — nginx).
