<?php
/* Paribesh Bandhu Jury API — shared code: config, database, helpers, Google Drive.
 * Secrets live OUTSIDE public_html in ../../private/pbj-config.php (see config.sample.php). */
declare(strict_types=1);

const SCHEMA_VERSION = 1;
const SCORE_MAX = ['A' => 100, 'B' => 120, 'C' => 160, 'D' => 90, 'E' => 90, 'F' => 80, 'G' => 60, 'H' => 50, 'I' => 80, 'J' => 100, 'K' => 40, 'L' => 30];
const LIMITS = [
  'TOKEN_DAYS' => 30,
  'MAX_UPLOAD_MB' => 20,
  'MAX_PHOTOS' => 15,
  'MAX_VIDEOS' => 8,
  'MAX_VIDEO_MB' => 800,
  'MEMBER_QUOTA_MB' => 4096,
  'MIN_FREE_MB' => 2048,
  'STORAGE_WARN_PCT' => 80,
  'LOGIN_MAX_FAILS' => 5,
  'LOGIN_LOCK_MIN' => 15,
  'THUMB_PX' => 400,
];
const VIDEO_CHUNK = 5 * 1024 * 1024;   // multiple of 256 KB (Drive rule)
const UPLOAD_TTL = 21600;              // seconds an unfinished video upload is remembered

class ApiError extends Exception {
  public string $apiCode;
  public function __construct(string $msg, string $code = '') { parent::__construct($msg); $this->apiCode = $code; }
}

function private_dir(): string { return dirname(__DIR__, 2) . '/private'; }

function cfg(string $k) {
  static $c = null;
  if ($c === null) {
    $f = private_dir() . '/pbj-config.php';
    if (!is_file($f)) throw new ApiError('Server is not configured yet.');
    $c = require $f;
  }
  return $c[$k] ?? null;
}

/* ---------------- database ---------------- */
function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $pdo = new PDO('mysql:host=' . cfg('db_host') . ';dbname=' . cfg('db_name') . ';charset=utf8mb4', cfg('db_user'), cfg('db_pass'), [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
  ]);
  $pdo->exec("SET time_zone = '+00:00'");
  ensure_schema($pdo);
  return $pdo;
}
function q(string $sql, array $p = []): PDOStatement { $s = db()->prepare($sql); $s->execute($p); return $s; }

/** Creates the tables on first use (a marker file avoids checking on every request). */
function ensure_schema(PDO $pdo): void {
  $mark = private_dir() . '/schema-v' . SCHEMA_VERSION . '.done';
  if (is_file($mark)) return;
  $t = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
  $pdo->exec("CREATE TABLE IF NOT EXISTS users (
    login VARCHAR(190) PRIMARY KEY, col_a VARCHAR(190) NOT NULL DEFAULT '', name VARCHAR(200) NOT NULL DEFAULT '',
    phone VARCHAR(60) NOT NULL DEFAULT '', role VARCHAR(30) NOT NULL DEFAULT '', active VARCHAR(30) NOT NULL DEFAULT '',
    last_login DATETIME NULL, team VARCHAR(200) NOT NULL DEFAULT '', area VARCHAR(255) NOT NULL DEFAULT '',
    alternate VARCHAR(100) NOT NULL DEFAULT '', source VARCHAR(255) NOT NULL DEFAULT '', alt_email VARCHAR(190) NOT NULL DEFAULT '',
    reference VARCHAR(255) NOT NULL DEFAULT '') $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS submissions (
    id VARCHAR(40) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, email VARCHAR(190) NOT NULL, member_name VARCHAR(255) NOT NULL DEFAULT '',
    location VARCHAR(255) NOT NULL DEFAULT '', folder_id VARCHAR(100) NOT NULL DEFAULT '', folder_url VARCHAR(255) NOT NULL DEFAULT '',
    data MEDIUMTEXT, status VARCHAR(20) NOT NULL DEFAULT 'Draft', created_at DATETIME NULL, updated_at DATETIME NULL,
    committee VARCHAR(255) NOT NULL DEFAULT '', KEY (email)) $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS files (
    id VARCHAR(100) PRIMARY KEY, seq BIGINT NOT NULL AUTO_INCREMENT UNIQUE, email VARCHAR(190) NOT NULL DEFAULT '', name VARCHAR(255) NOT NULL DEFAULT '',
    mime VARCHAR(150) NOT NULL DEFAULT '', kind VARCHAR(20) NOT NULL DEFAULT '', size_kb INT NOT NULL DEFAULT 0, uploaded_at DATETIME NULL,
    url VARCHAR(255) NOT NULL DEFAULT '', deleted TINYINT(1) NOT NULL DEFAULT 0, submission_id VARCHAR(40) NOT NULL DEFAULT '',
    caption VARCHAR(400) NOT NULL DEFAULT '', sections VARCHAR(60) NOT NULL DEFAULT '', captured_at VARCHAR(40) NOT NULL DEFAULT '',
    capture_source VARCHAR(20) NOT NULL DEFAULT '', lat DOUBLE NULL, lng DOUBLE NULL, original_kb INT NOT NULL DEFAULT 0,
    compressed TINYINT(1) NOT NULL DEFAULT 0, uploaded_by VARCHAR(190) NOT NULL DEFAULT '', charged_to VARCHAR(190) NOT NULL DEFAULT '',
    thumb MEDIUMTEXT NULL, KEY (submission_id), KEY (charged_to)) $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS activity_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, ts DATETIME(3) NOT NULL, email VARCHAR(190) NOT NULL DEFAULT '', name VARCHAR(200) NOT NULL DEFAULT '',
    action VARCHAR(40) NOT NULL DEFAULT '', details VARCHAR(600) NOT NULL DEFAULT '') $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS uploads (id VARCHAR(40) PRIMARY KEY, data MEDIUMTEXT NOT NULL, expires INT NOT NULL) $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS login_fails (phone VARCHAR(20) PRIMARY KEY, fails INT NOT NULL, until INT NOT NULL) $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS kv (k VARCHAR(60) PRIMARY KEY, v MEDIUMTEXT NOT NULL, expires INT NOT NULL) $t");
  // changes made in the app that the Apps Script copies into the Users sheet (the sheet stays the master list)
  $pdo->exec("CREATE TABLE IF NOT EXISTS user_changes (id BIGINT AUTO_INCREMENT PRIMARY KEY, login VARCHAR(190) NOT NULL,
    op VARCHAR(10) NOT NULL, cols TEXT NOT NULL, created DATETIME NOT NULL) $t");
  $pdo->exec("CREATE TABLE IF NOT EXISTS mail_queue (id BIGINT AUTO_INCREMENT PRIMARY KEY, to_addr VARCHAR(190) NOT NULL,
    subject VARCHAR(255) NOT NULL, body MEDIUMTEXT NOT NULL, html TINYINT(1) NOT NULL DEFAULT 0, created DATETIME NOT NULL) $t");
  @file_put_contents($mark, date('c'));
}

function kv_get(string $k): ?string {
  $r = q('SELECT v, expires FROM kv WHERE k = ?', [$k])->fetch();
  return $r && ($r['expires'] === 0 || $r['expires'] > time()) ? $r['v'] : null;
}
function kv_set(string $k, string $v, int $expires): void {
  q('INSERT INTO kv (k, v, expires) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), expires = VALUES(expires)', [$k, $v, $expires]);
}

/* ---------------- helpers (same rules as Code.gs) ---------------- */
/** Emails lower-cased; mobiles reduced to their last 10 digits. */
function norm($s): string {
  $v = strtolower(trim(scalar_str($s)));
  if (strpos($v, '@') === false) {
    $d = preg_replace('/\D/', '', $v);
    if (strlen($d) >= 10) return substr($d, -10);
  }
  return $v;
}
/** Sheet values arrive as JSON: numbers, booleans, strings. */
function scalar_str($v): string {
  if ($v === null) return '';
  if (is_bool($v)) return $v ? 'TRUE' : 'FALSE';
  if (is_float($v) && floor($v) == $v && abs($v) < 1e15) return sprintf('%.0f', $v);
  return (string) $v;
}
function truthy($v): bool { return $v === true || strtoupper(scalar_str($v)) === 'TRUE'; }
function now_db(): string { return gmdate('Y-m-d H:i:s'); }
/** DB datetime (UTC) → ISO string like Apps Script's Date.toISOString(). */
function iso(?string $d): string { return $d ? str_replace(' ', 'T', substr($d, 0, 19)) . '.000Z' : ''; }
/** ISO / sheet date → DB datetime (UTC), or null. */
function to_db_date($v): ?string {
  $s = trim(scalar_str($v));
  if ($s === '') return null;
  try { return (new DateTimeImmutable($s))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s'); } catch (Exception $e) { return null; }
}
function cut(string $s, int $n): string { return mb_substr($s, 0, $n); }
function new_id(string $prefix, int $len): string { return $prefix . substr(bin2hex(random_bytes(16)), 0, $len); }
function ist_stamp(string $fmt): string { return (new DateTimeImmutable('now', new DateTimeZone('Asia/Kolkata')))->format($fmt); }

/* ---------------- users ---------------- */
function user_from_row(array $r): array {
  $a = strtoupper($r['active']);
  return [
    'email' => $r['login'], 'name' => $r['name'], 'phone' => $r['phone'],
    'role' => norm($r['role']) === 'admin' ? 'admin' : 'jury',
    'active' => $r['active'] === '' ? true : truthy($r['active']),
    'pending' => $a === 'PENDING', 'rejected' => $a === 'REJECTED',
    'lastLogin' => $r['last_login'], 'team' => $r['team'], 'area' => $r['area'], 'alternate' => $r['alternate'],
    'altEmail' => strtolower(trim($r['alt_email'])), 'reference' => $r['reference'], 'source' => $r['source'],
  ];
}
function all_users(bool $fresh = false): array {
  static $cache = null;
  if ($cache === null || $fresh) $cache = array_map('user_from_row', q('SELECT * FROM users ORDER BY login')->fetchAll());
  return $cache;
}
function find_user(string $email): ?array {
  if ($email === '') return null;
  foreach (all_users() as $u) if ($u['email'] === $email) return $u;
  if (strpos($email, '@') !== false) foreach (all_users() as $u) if ($u['altEmail'] !== '' && $u['altEmail'] === $email) return $u;
  return null;
}
function user_names(): array { $n = []; foreach (all_users() as $u) $n[$u['email']] = $u['name']; return $n; }
function public_user(array $u): array {
  $isMail = strpos($u['email'], '@') !== false;
  return ['email' => $u['email'], 'name' => $u['name'], 'phone' => $u['phone'] !== '' ? $u['phone'] : ($isMail ? '' : $u['email']),
    'role' => $u['role'], 'mustChange' => false, 'contactEmail' => $u['altEmail'] !== '' ? $u['altEmail'] : ($isMail ? $u['email'] : ''),
    'altPhone' => $u['alternate'], 'area' => (string) $u['area']];
}
/** Queue a change for the Users sheet. op 'set' = update cells (by column letter) in the row whose column A is $login; 'append' = add a row. */
function sheet_change(string $login, string $op, array $cols): void {
  q('INSERT INTO user_changes (login, op, cols, created) VALUES (?, ?, ?, ?)', [$login, $op, json_encode($cols), now_db()]);
}

/* ---------------- tokens ---------------- */
function b64url(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function make_token(array $u): string {
  $p = json_encode(['e' => $u['email'], 'exp' => (time() + LIMITS['TOKEN_DAYS'] * 86400) * 1000]);
  return b64url($p) . '.' . b64url(hash_hmac('sha256', $p, (string) cfg('token_secret'), true));
}
function auth_err(): ApiError { return new ApiError('Session expired. Please log in again.', 'AUTH'); }
function auth(?string $token): array {
  $parts = explode('.', (string) $token);
  if (count($parts) !== 2) throw auth_err();
  $p = base64_decode(strtr($parts[0], '-_', '+/'));
  if ($p === false || !hash_equals(b64url(hash_hmac('sha256', $p, (string) cfg('token_secret'), true)), $parts[1])) throw auth_err();
  $d = json_decode($p, true);
  if (!$d || time() * 1000 > ($d['exp'] ?? 0)) throw auth_err();
  $u = find_user((string) $d['e']);
  if (!$u || !$u['active']) throw auth_err();
  return $u;
}

function log_act(array $u, string $action, string $details = ''): void {
  try { q('INSERT INTO activity_log (ts, email, name, action, details) VALUES (UTC_TIMESTAMP(3), ?, ?, ?, ?)', [$u['email'], $u['name'] ?? '', $action, cut($details, 500)]); }
  catch (Throwable $e) {}
}
function queue_mail(string $to, string $subject, string $body, bool $html = false): void {
  q('INSERT INTO mail_queue (to_addr, subject, body, html, created) VALUES (?, ?, ?, ?, ?)', [$to, $subject, $body, $html ? 1 : 0, now_db()]);
}

/* ---------------- Apps Script (Google side) ---------------- */
/** Calls the Apps Script web app with the shared key. Only used for the Drive token and to re-read the Users sheet. */
function gas_call(array $body, int $timeout = 60): array {
  $body['key'] = cfg('gas_key');
  [$code, , $res] = http('POST', (string) cfg('gas_url'), ['body' => json_encode($body), 'headers' => ['Content-Type: text/plain;charset=utf-8'], 'timeout' => $timeout, 'follow' => true]);
  $d = json_decode($res, true);
  if ($code !== 200 || !is_array($d) || empty($d['ok'])) throw new ApiError('Google is not responding right now. Please try again.');
  return $d;
}

/* ---------------- HTTP ---------------- */
/** @return array{0:int,1:array,2:string} status, lower-cased headers, body */
function http(string $method, string $url, array $o = []): array {
  $h = [];
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $o['timeout'] ?? 60, CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_HTTPHEADER => $o['headers'] ?? [], CURLOPT_FOLLOWLOCATION => !empty($o['follow']),
    CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$h) {
      $p = strpos($line, ':');
      if ($p !== false) $h[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
      return strlen($line);
    },
  ]);
  if (array_key_exists('body', $o)) curl_setopt($ch, CURLOPT_POSTFIELDS, $o['body']);
  $res = curl_exec($ch);
  $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
  if ($res === false) throw new ApiError('Could not reach Google Drive. Please try again.');
  return [$code, $h, (string) $res];
}

/* ---------------- Google Drive ---------------- */
/** Access token for the server's Google account. The Apps Script pushes a fresh one every 10 minutes;
 *  if it is missing or rejected we ask the Apps Script directly. */
function drive_token(bool $refresh = false): string {
  if (!$refresh && ($t = kv_get('drive_token'))) return $t;
  $r = gas_call(['action' => 'driveToken']);
  kv_set('drive_token', (string) $r['token'], time() + 45 * 60);
  return (string) $r['token'];
}
/** Drive REST call with the token; retries once with a fresh token on 401. */
function drive(string $method, string $url, array $o = []): array {
  for ($try = 0; $try < 2; $try++) {
    $o2 = $o;
    $o2['headers'] = array_merge($o['headers'] ?? [], ['Authorization: Bearer ' . drive_token($try > 0)]);
    $r = http($method, $url, $o2);
    if ($r[0] !== 401) return $r;
  }
  return $r;
}
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UP = 'https://www.googleapis.com/upload/drive/v3/files';

function drive_json(string $method, string $url, ?array $json = null): array {
  [$code, , $body] = drive($method, $url, $json === null ? [] : ['body' => json_encode($json), 'headers' => ['Content-Type: application/json; charset=UTF-8']]);
  $d = json_decode($body, true) ?: [];
  if ($code < 200 || $code >= 300) throw new ApiError('Google Drive error (' . $code . '). Please try again.');
  return $d;
}
function drive_create_folder(string $name, string $parent, string $desc): array {
  return drive_json('POST', DRIVE . '?supportsAllDrives=true&fields=id,webViewLink',
    ['name' => $name, 'mimeType' => 'application/vnd.google-apps.folder', 'parents' => [$parent], 'description' => $desc]);
}
function drive_folder_ok(string $id): ?array {
  if ($id === '') return null;
  [$code, , $body] = drive('GET', DRIVE . '/' . rawurlencode($id) . '?supportsAllDrives=true&fields=id,name,trashed');
  $d = json_decode($body, true);
  return $code === 200 && empty($d['trashed']) ? $d : null;
}
function drive_upload(string $bytes, string $mime, string $name, string $parent, string $desc): array {
  $b = 'pbj' . bin2hex(random_bytes(8));
  $body = "--$b\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" . json_encode(['name' => $name, 'parents' => [$parent], 'description' => $desc]) .
    "\r\n--$b\r\nContent-Type: $mime\r\n\r\n" . $bytes . "\r\n--$b--";
  [$code, , $res] = drive('POST', DRIVE_UP . '?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
    ['body' => $body, 'headers' => ['Content-Type: multipart/related; boundary=' . $b], 'timeout' => 120]);
  $d = json_decode($res, true);
  if ($code !== 200 || empty($d['id'])) throw new ApiError('Upload to Google Drive failed (' . $code . '). Please try again.');
  return $d;
}
function drive_trash(string $id): void { try { drive_json('PATCH', DRIVE . '/' . rawurlencode($id) . '?supportsAllDrives=true', ['trashed' => true]); } catch (Throwable $e) {} }

/** Bytes + type of a Drive file. Images are kept in private/cache so the gallery opens them instantly next time. */
function drive_media(string $id): array {
  $dir = private_dir() . '/cache';
  $f = $dir . '/' . preg_replace('/[^\w-]/', '', $id);
  if (is_file($f) && is_file($f . '.type')) return [file_get_contents($f), file_get_contents($f . '.type')];
  [$code, $h, $body] = drive('GET', DRIVE . '/' . rawurlencode($id) . '?alt=media&supportsAllDrives=true', ['timeout' => 120]);
  if ($code !== 200) throw new ApiError('File not found');
  $type = explode(';', $h['content-type'] ?? 'application/octet-stream')[0];
  if (strpos($type, 'image/') === 0 && strlen($body) < 8 * 1048576) {
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    @file_put_contents($f, $body); @file_put_contents($f . '.type', $type);
  }
  return [$body, $type];
}

/** Free space in the server's Drive, or null when unlimited. Cached for 10 minutes. */
function drive_quota(): array {
  $c = kv_get('drive_quota');
  if ($c) return json_decode($c, true);
  $d = drive_json('GET', 'https://www.googleapis.com/drive/v3/about?fields=storageQuota');
  $q = ['limit' => (float) ($d['storageQuota']['limit'] ?? 0), 'usage' => (float) ($d['storageQuota']['usage'] ?? 0)];
  kv_set('drive_quota', json_encode($q), time() + 600);
  return $q;
}

/** Drive's own previews (photos and videos), CFG THUMB_PX wide, fetched in parallel. id → data URL (or nothing). */
function drive_thumbs(array $ids): array {
  if (!$ids) return [];
  $tok = drive_token();
  $multi = function (array $urls) use ($tok): array {
    $mh = curl_multi_init(); $hs = [];
    foreach ($urls as $k => $u) {
      $ch = curl_init($u);
      curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $tok]]);
      curl_multi_add_handle($mh, $ch); $hs[$k] = $ch;
    }
    do { $st = curl_multi_exec($mh, $run); if ($run) curl_multi_select($mh, 1.0); } while ($run && $st === CURLM_OK);
    $out = [];
    foreach ($hs as $k => $ch) {
      $out[$k] = [(int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE), (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE), (string) curl_multi_getcontent($ch)];
      curl_multi_remove_handle($mh, $ch); curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
  };
  $links = [];
  foreach ($multi(array_combine($ids, array_map(fn($id) => DRIVE . '/' . rawurlencode($id) . '?fields=thumbnailLink&supportsAllDrives=true', $ids))) as $id => [$code, , $body]) {
    $l = $code === 200 ? (json_decode($body, true)['thumbnailLink'] ?? '') : '';
    if ($l) $links[$id] = preg_replace('/=s\d+$/', '=s' . LIMITS['THUMB_PX'], $l);
  }
  $out = [];
  foreach ($multi($links) as $id => [$code, $type, $body]) {
    $type = explode(';', $type)[0];
    if ($code === 200 && strpos($type, 'image/') === 0 && $body !== '') $out[$id] = 'data:' . $type . ';base64,' . base64_encode($body);
  }
  return $out;
}
