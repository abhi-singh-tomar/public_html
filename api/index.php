<?php
/* Paribesh Bandhu Jury API (PHP + MySQL). Same requests and replies as the old Apps Script backend,
 * so the app only needs API_URL pointed here. Files stay in Google Drive. */
declare(strict_types=1);
require __DIR__ . '/_lib.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function reply(array $o): void { echo json_encode($o, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); exit; }

if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(['ok' => true, 'service' => 'Paribesh Bandhu Jury API', 'time' => gmdate('c')]);

$req = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($req) || empty($req['action'])) reply(['ok' => false, 'error' => 'Bad request']);

try {
  $action = (string) $req['action'];
  if ($action === 'loginByPhone') reply(login_by_phone($req));
  if ($action === 'register') reply(register($req));
  if (strpos($action, 'sync') === 0) { require_once __DIR__ . '/_sync.php'; reply(sync_route($action, $req)); }
  $user = auth($req['token'] ?? null);
  $handlers = [
    'me' => 'me', 'updateProfile' => 'update_profile', 'listCommittees' => 'list_committees', 'getSubmission' => 'get_submission',
    'saveSubmission' => 'save_submission', 'uploadFile' => 'upload_file', 'uploadStart' => 'upload_start', 'uploadChunk' => 'upload_chunk',
    'uploadStatus' => 'upload_status', 'uploadCancel' => 'upload_cancel', 'updateFileMeta' => 'update_file_meta', 'deleteFile' => 'delete_file',
    'getFile' => 'get_file', 'getThumbs' => 'get_thumbs', 'adminList' => 'admin_list', 'adminGet' => 'admin_get', 'adminLog' => 'admin_log',
    'adminApprove' => 'admin_approve', 'adminSetRole' => 'admin_set_role',
  ];
  if (!isset($handlers[$action])) throw new ApiError('Unknown action');
  if (strpos($action, 'admin') === 0 && $user['role'] !== 'admin') throw new ApiError('Not permitted');
  reply($handlers[$action]($user, $req));
} catch (ApiError $e) {
  reply(['ok' => false, 'error' => $e->getMessage(), 'code' => $e->apiCode]);
} catch (Throwable $e) {
  @file_put_contents(private_dir() . '/error.log', gmdate('c') . ' ' . ($action ?? '') . ' ' . $e->getMessage() . ' @' . $e->getFile() . ':' . $e->getLine() . "\n", FILE_APPEND);
  reply(['ok' => false, 'error' => 'Server error. Please try again.']);
}

/* =================================================================
 *  AUTH
 * ================================================================= */
function login_by_phone(array $req): array {
  $phone = substr(preg_replace('/\D/', '', (string) ($req['phone'] ?? '')), -10);
  if (!preg_match('/^\d{10}$/', $phone)) return ['ok' => false, 'error' => 'Enter your 10-digit mobile number'];
  $f = q('SELECT fails, until FROM login_fails WHERE phone = ?', [$phone])->fetch();
  if ($f && $f['until'] > time() && $f['fails'] >= LIMITS['LOGIN_MAX_FAILS']) return ['ok' => false, 'error' => 'Too many attempts. Try again in ' . LIMITS['LOGIN_LOCK_MIN'] . ' minutes.'];
  $find = function () use ($phone) {
    foreach (all_users(true) as $x) if ($x['email'] === $phone || norm($x['phone']) === $phone) return $x;
    return null;
  };
  $u = $find();
  if (!$u) {
    // maybe just added to the Users sheet by the back office: read the sheet now (at most once a minute)
    if (!kv_get('sheet_pull_recent')) {
      kv_set('sheet_pull_recent', '1', time() + 60);
      try { require_once __DIR__ . '/_sync.php'; $r = gas_call(['action' => 'usersSnapshot'], 40); upsert_users($r['rows'] ?? []); $u = $find(); } catch (Throwable $e) {}
    }
  }
  if (!$u) {
    $fails = $f && $f['until'] > time() ? $f['fails'] + 1 : 1;
    q('REPLACE INTO login_fails (phone, fails, until) VALUES (?, ?, ?)', [$phone, $fails, time() + LIMITS['LOGIN_LOCK_MIN'] * 60]);
    return ['ok' => false, 'error' => 'This mobile number is not registered'];
  }
  if ($u['pending']) return ['ok' => false, 'error' => 'Your registration is awaiting approval. You will be able to log in once the organisers approve it.'];
  if (!$u['active']) return ['ok' => false, 'error' => 'Your account is not active. Please contact the organising team.'];
  q('DELETE FROM login_fails WHERE phone = ?', [$phone]);
  $now = now_db();
  q('UPDATE users SET last_login = ? WHERE login = ?', [$now, $u['email']]);
  sheet_change($u['email'], 'set', ['I' => ['date' => iso($now)]]);
  log_act($u, 'LOGIN', 'mobile');
  return ['ok' => true, 'token' => make_token($u), 'user' => public_user($u)];
}

/* =================================================================
 *  SUBMISSIONS & FILES (data access)
 * ================================================================= */
function sub_from_row(array $r): array {
  $data = json_decode((string) $r['data'], true) ?: [];
  return ['id' => $r['id'], 'email' => $r['email'], 'memberName' => $r['member_name'], 'location' => $r['location'], 'folderId' => $r['folder_id'],
    'folderUrl' => $r['folder_url'], 'data' => $data, 'status' => $r['status'] ?: 'Draft', 'createdAt' => $r['created_at'], 'updatedAt' => $r['updated_at'],
    'committee' => $r['committee'] !== '' ? $r['committee'] : (string) ($data['committeeName'] ?? '')];
}
function find_sub(?string $id): ?array {
  if (!$id) return null;
  $r = q('SELECT * FROM submissions WHERE id = ?', [$id])->fetch();
  return $r ? sub_from_row($r) : null;
}
function subs_for(string $email): array { return array_map('sub_from_row', q('SELECT * FROM submissions WHERE email = ? ORDER BY seq', [$email])->fetchAll()); }
function all_subs(): array { return array_map('sub_from_row', q('SELECT * FROM submissions ORDER BY seq')->fetchAll()); }

function file_counts(): array {
  $c = [];
  foreach (q("SELECT submission_id, kind, COUNT(*) n FROM files WHERE deleted = 0 AND submission_id <> '' GROUP BY submission_id, kind")->fetchAll() as $r) {
    $c[$r['submission_id']] = $c[$r['submission_id']] ?? ['photo' => 0, 'video' => 0, 'document' => 0];
    $k = $r['kind'] === 'photo' || $r['kind'] === 'video' ? $r['kind'] : 'document';
    $c[$r['submission_id']][$k] += (int) $r['n'];
  }
  return $c;
}
function marks_total(array $data): ?float {
  $t = 0; $any = false;
  foreach (array_keys(SCORE_MAX) as $k) {
    $v = $data['score_' . $k] ?? '';
    if ($v === '' || !is_numeric($v)) continue;
    $t += (float) $v; $any = true;
  }
  return $any ? round($t, 2) : null;
}
function summaries(array $subs, bool $withFolder = false): array {
  $counts = file_counts();
  $out = array_map(function ($s) use ($counts, $withFolder) {
    $c = $counts[$s['id']] ?? ['photo' => 0, 'video' => 0, 'document' => 0];
    $o = ['id' => $s['id'], 'email' => $s['email'], 'memberName' => (string) $s['memberName'], 'committeeName' => $s['committee'], 'area' => $s['location'],
      'status' => $s['status'], 'createdAt' => iso($s['createdAt']), 'updatedAt' => iso($s['updatedAt']), 'photos' => $c['photo'], 'videos' => $c['video'],
      'documents' => $c['document'], 'marks' => marks_total($s['data'])];
    if ($withFolder) $o['folderUrl'] = $s['folderUrl'];
    return $o;
  }, $subs);
  usort($out, fn($a, $b) => strcmp($b['updatedAt'], $a['updatedAt']));
  return $out;
}
function public_sub(array $s, bool $withFolder): array {
  $o = ['id' => $s['id'], 'data' => (object) $s['data'], 'status' => $s['status'], 'committeeName' => $s['committee'], 'memberName' => $s['memberName'],
    'location' => $s['location'], 'createdAt' => iso($s['createdAt']), 'updatedAt' => iso($s['updatedAt'])];
  if ($withFolder) $o['folderUrl'] = $s['folderUrl'];
  return $o;
}
function list_files(string $subId, bool $withUrl = false): array {
  return array_map(function ($r) use ($withUrl) {
    $o = ['id' => $r['id'], 'name' => $r['name'], 'mimeType' => $r['mime'], 'kind' => $r['kind'], 'sizeKB' => (int) $r['size_kb'], 'uploadedAt' => iso($r['uploaded_at']),
      'caption' => $r['caption'], 'sections' => $r['sections'], 'capturedAt' => $r['captured_at'], 'captureSource' => $r['capture_source'],
      'lat' => $r['lat'] === null ? null : (float) $r['lat'], 'lng' => $r['lng'] === null ? null : (float) $r['lng'],
      'originalSizeKB' => (int) $r['original_kb'] ?: (int) $r['size_kb'], 'compressed' => (bool) $r['compressed'], 'uploadedBy' => $r['uploaded_by']];
    if ($withUrl) $o['url'] = $r['url'];
    return $o;
  }, q('SELECT id, name, mime, kind, size_kb, uploaded_at, url, caption, sections, captured_at, capture_source, lat, lng, original_kb, compressed, uploaded_by
        FROM files WHERE submission_id = ? AND deleted = 0 ORDER BY seq', [$subId])->fetchAll());
}
function find_file(?string $id): ?array {
  if (!$id) return null;
  $r = q('SELECT * FROM files WHERE id = ?', [$id])->fetch();
  return $r ?: null;
}

function can_edit(array $u, ?array $s): bool { return $s && ($s['email'] === $u['email'] || $u['role'] === 'admin'); }
function can_manage_file(array $u, ?array $r): bool { return $r && ($r['uploaded_by'] === $u['email'] || $r['email'] === $u['email'] || $u['role'] === 'admin'); }
function charge_to(array $u, array $s): string { return $u['role'] === 'admin' ? $s['email'] : $u['email']; }

function files_view(array $u, array $s): array {
  $all = list_files($s['id'], $u['role'] === 'admin'); $names = user_names();
  $totals = ['photo' => 0, 'video' => 0, 'document' => 0];
  foreach ($all as &$f) {
    $f['uploadedByName'] = $names[$f['uploadedBy']] ?? $f['uploadedBy'];
    $f['mine'] = $f['uploadedBy'] === $u['email']; $f['byOther'] = $f['uploadedBy'] !== $s['email'];
    $totals[$f['kind'] === 'photo' || $f['kind'] === 'video' ? $f['kind'] : 'document']++;
  }
  unset($f);
  return ['files' => can_edit($u, $s) ? $all : array_values(array_filter($all, fn($f) => $f['mine'])), 'totals' => $totals];
}
function files_reply(array $u, array $s): array { $v = files_view($u, $s); return ['ok' => true, 'files' => $v['files'], 'totals' => $v['totals'], 'storage' => storage_info(charge_to($u, $s))]; }
function contrib_note(array $u, array $s): string { return $s['email'] !== $u['email'] && $u['role'] !== 'admin' ? ' (added to ' . $s['email'] . '\'s committee)' : ''; }

/* ---- storage ---- */
function member_used_kb(string $email): float { return (float) q('SELECT COALESCE(SUM(size_kb), 0) FROM files WHERE deleted = 0 AND charged_to = ?', [$email])->fetchColumn(); }
function storage_info(string $email): array {
  $used = member_used_kb($email) * 1024; $quota = LIMITS['MEMBER_QUOTA_MB'] * 1048576;
  return ['usedMB' => round($used / 1048576, 1), 'quotaMB' => LIMITS['MEMBER_QUOTA_MB'], 'leftMB' => max(0, round(($quota - $used) / 1048576, 1)),
    'warn' => $used >= $quota * LIMITS['STORAGE_WARN_PCT'] / 100];
}
function check_storage(string $email, int $add): void {
  $used = member_used_kb($email) * 1024; $quota = LIMITS['MEMBER_QUOTA_MB'] * 1048576;
  if ($used + $add > $quota) throw new ApiError('Storage limit reached: this upload needs ' . ceil($add / 1048576) . ' MB but only ' .
    max(0, floor(($quota - $used) / 1048576)) . ' MB of the ' . LIMITS['MEMBER_QUOTA_MB'] . ' MB allowance is left. Delete some files or contact the organisers.');
  $q = drive_quota();
  if ($q['limit'] > 0 && $q['limit'] - $q['usage'] - $add < LIMITS['MIN_FREE_MB'] * 1048576)
    throw new ApiError('The portal\'s storage is almost full, so uploads are paused. Please contact the organising team.');
}

/* =================================================================
 *  JURY MEMBER ACTIONS
 * ================================================================= */
function me(array $u): array { return ['ok' => true, 'user' => public_user($u), 'submissions' => summaries(subs_for($u['email'])), 'storage' => storage_info($u['email'])]; }

function update_profile(array $u, array $req): array {
  $name = cut(trim((string) ($req['name'] ?? '')), 100);
  $email = cut(strtolower(trim((string) ($req['contactEmail'] ?? ''))), 120);
  $alt = cut(trim(preg_replace('/[^\d,\/ +]/', '', (string) ($req['altPhone'] ?? ''))), 60);
  $area = cut(trim((string) ($req['area'] ?? '')), 200);
  if ($name === '') throw new ApiError('Enter your full name');
  if ($email !== '' && !preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) throw new ApiError('Enter a valid email or leave it blank');
  q('UPDATE users SET name = ?, area = ?, alternate = ?, alt_email = ? WHERE login = ?', [$name, $area, $alt, $email, $u['email']]);
  sheet_change($u['email'], 'set', ['B' => $name, 'K' => $area, 'L' => $alt, 'N' => $email]);
  $changed = [];
  foreach (['name' => [$u['name'], $name], 'email' => [$u['altEmail'], $email], 'alternate' => [$u['alternate'], $alt], 'area' => [$u['area'], $area]] as $k => [$a, $b]) if ((string) $a !== $b) $changed[] = $k;
  log_act(['email' => $u['email'], 'name' => $name], 'PROFILE_UPDATED', $changed ? 'Changed: ' . implode(', ', $changed) : 'No field changes');
  all_users(true);
  return ['ok' => true, 'user' => public_user(find_user($u['email']))];
}

function get_submission(array $u, array $req): array {
  $s = find_sub($req['id'] ?? null);
  if (!$s) throw new ApiError('Committee form not found');
  $v = files_view($u, $s);
  if (can_edit($u, $s)) return ['ok' => true, 'submission' => public_sub($s, $u['role'] === 'admin'), 'files' => $v['files'], 'totals' => $v['totals'], 'storage' => storage_info($s['email'])];
  $owner = find_user($s['email']);
  return ['ok' => true, 'contributor' => true, 'files' => $v['files'], 'totals' => $v['totals'], 'storage' => storage_info($u['email']),
    'submission' => ['id' => $s['id'], 'committeeName' => $s['committee'], 'location' => $s['location'], 'status' => $s['status'], 'filledBy' => $owner ? $owner['name'] : $s['memberName']]];
}

function list_committees(array $u): array {
  $names = user_names(); $mine = [];
  foreach (q('SELECT submission_id, COUNT(*) n FROM files WHERE deleted = 0 AND uploaded_by = ? GROUP BY submission_id', [$u['email']])->fetchAll() as $r) $mine[$r['submission_id']] = (int) $r['n'];
  $subs = all_subs(); $myAreas = []; $list = [];
  foreach ($subs as $s) {
    if ($s['email'] === $u['email']) { $myAreas[] = $s['location']; continue; }
    $list[] = ['id' => $s['id'], 'committeeName' => $s['committee'], 'area' => $s['location'], 'status' => $s['status'],
      'filledBy' => $names[$s['email']] ?? ($s['memberName'] ?: ''), 'myFiles' => $mine[$s['id']] ?? 0, 'updatedAt' => iso($s['updatedAt'])];
  }
  usort($list, fn($a, $b) => strcasecmp((string) $a['committeeName'], (string) $b['committeeName']));
  if ($u['area'] !== '') $myAreas[] = (string) $u['area'];
  return ['ok' => true, 'committees' => $list, 'myAreas' => $myAreas];
}

function folder_name(string $name, string $loc): string {
  $n = preg_replace('/[\\\\\/:*?"<>|]+/', '_', trim($name) . ($loc !== '' ? ' - ' . trim($loc) : ''));
  return cut($n, 150) ?: 'Unnamed';
}
/** The Apps Script reports its ROOT_FOLDER_ID on every sync; the config value is the fallback. */
function root_folder(): string { return kv_get('root_folder_id') ?: (string) cfg('root_folder_id'); }

function save_submission(array $u, array $req): array {
  $data = is_array($req['data'] ?? null) ? $req['data'] : [];
  foreach ($data as $k => $v) $data[$k] = cut(trim(scalar_str($v)), 5000);
  $status = ($req['status'] ?? '') === 'Submitted' ? 'Submitted' : 'Draft';
  $member = ($data['memberName'] ?? '') !== '' ? $data['memberName'] : ($u['name'] ?: $u['email']);
  $committee = $data['committeeName'] ?? ''; $loc = $data['area'] ?? '';
  if ($committee === '' || $loc === '') throw new ApiError('Committee name and area are needed to save');
  foreach (SCORE_MAX as $k => $max) {
    $v = $data['score_' . $k] ?? '';
    if ($v === '') continue;
    if (!is_numeric($v) || $v < 0 || $v > $max) throw new ApiError('Marks for section ' . $k . ' must be between 0 and ' . $max);
  }
  $id = (string) ($req['id'] ?? '');
  $now = now_db(); $fname = folder_name($committee, $loc);
  $s = $id !== '' ? find_sub($id) : null;
  if ($id !== '' && !can_edit($u, $s)) throw new ApiError('Committee form not found');
  if (!$s) {
    $id = new_id('S', 12);
    $f = drive_create_folder($fname, root_folder(), 'Committee: ' . $committee . ' | Area: ' . $loc . ' | Jury: ' . $member . ' (' . $u['email'] . ')');
    q('INSERT INTO submissions (id, email, member_name, location, folder_id, folder_url, data, status, created_at, updated_at, committee) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [$id, $u['email'], $member, $loc, $f['id'], $f['webViewLink'] ?? ('https://drive.google.com/drive/folders/' . $f['id']), json_encode($data, JSON_UNESCAPED_UNICODE), $status, $now, $now, $committee]);
    log_act($u, 'SUBMISSION_CREATED', $fname);
  } else {
    $folderId = $s['folderId']; $folderUrl = $s['folderUrl'];
    $cur = drive_folder_ok($folderId);
    if (!$cur) {
      $nf = drive_create_folder($fname, root_folder(), 'Committee: ' . $committee . ' | Area: ' . $loc);
      $folderId = $nf['id']; $folderUrl = $nf['webViewLink'] ?? ('https://drive.google.com/drive/folders/' . $nf['id']);
    } elseif (($cur['name'] ?? '') !== $fname) {
      try { drive_json('PATCH', DRIVE . '/' . rawurlencode($folderId) . '?supportsAllDrives=true', ['name' => $fname]); } catch (Throwable $e) {}
    }
    $newStatus = $s['status'] === 'Submitted' && $status === 'Draft' ? 'Submitted' : $status;
    q('UPDATE submissions SET member_name = ?, location = ?, folder_id = ?, folder_url = ?, data = ?, status = ?, updated_at = ?, committee = ? WHERE id = ?',
      [$member, $loc, $folderId, $folderUrl, json_encode($data, JSON_UNESCAPED_UNICODE), $newStatus, $now, $committee, $id]);
    $changed = [];
    foreach (array_unique(array_merge(array_keys($s['data']), array_keys($data))) as $k) if ((string) ($s['data'][$k] ?? '') !== (string) ($data[$k] ?? '')) $changed[] = $k;
    $act = $s['email'] !== $u['email'] ? 'ADMIN_EDITED' : ($status === 'Submitted' ? 'SUBMITTED' : 'SUBMISSION_UPDATED');
    log_act($u, $act, $fname . ($s['email'] !== $u['email'] ? ' (jury ' . $s['email'] . ')' : '') . ' — ' . ($changed ? 'Changed: ' . implode(', ', $changed) : 'No field changes'));
  }
  $saved = find_sub($id); $v = files_view($u, $saved);
  return ['ok' => true, 'submission' => public_sub($saved, $u['role'] === 'admin'), 'files' => $v['files'], 'totals' => $v['totals'], 'submissions' => summaries(subs_for($saved['email']))];
}

function clean_meta(array $req): array {
  $secs = array_values(array_unique(array_filter(preg_split('/[^A-Z]+/', strtoupper((string) ($req['sections'] ?? ''))), fn($k) => isset(SCORE_MAX[$k]))));
  sort($secs);
  $t = null;
  if (!empty($req['capturedAt'])) { try { $t = new DateTimeImmutable((string) $req['capturedAt']); } catch (Exception $e) {} }
  $lat = $req['lat'] ?? ''; $lng = $req['lng'] ?? '';
  $has = $lat !== '' && $lat !== null && is_numeric($lat) && is_numeric($lng) && abs((float) $lat) <= 90 && abs((float) $lng) <= 180;
  $ok = $t && (int) $t->format('Y') > 1990;
  return ['caption' => cut(trim((string) ($req['caption'] ?? '')), 300), 'sections' => implode(',', $secs),
    'capturedAt' => $ok ? $t->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\TH:i:s.v\Z') : '',
    'captureSource' => $ok && in_array($req['captureSource'] ?? '', ['camera', 'video', 'file'], true) ? $req['captureSource'] : '',
    'lat' => $has ? round((float) $lat, 6) : null, 'lng' => $has ? round((float) $lng, 6) : null];
}
function safe_name(string $n, string $def): string { return cut(preg_replace('/[\\\\\/:*?"<>|]+/', '_', $n !== '' ? $n : $def), 120); }
function count_kind(string $subId, string $kind): int { return (int) q('SELECT COUNT(*) FROM files WHERE submission_id = ? AND deleted = 0 AND kind = ?', [$subId, $kind])->fetchColumn(); }
function insert_file(array $f): void {
  q('INSERT INTO files (id, email, name, mime, kind, size_kb, uploaded_at, url, deleted, submission_id, caption, sections, captured_at, capture_source, lat, lng, original_kb, compressed, uploaded_by, charged_to)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)',
    [$f['id'], $f['email'], $f['name'], $f['mime'], $f['kind'], $f['size_kb'], now_db(), $f['url'], $f['sub'], $f['m']['caption'], $f['m']['sections'],
      $f['m']['capturedAt'], $f['m']['captureSource'], $f['m']['lat'], $f['m']['lng'], $f['original_kb'], $f['compressed'] ? 1 : 0, $f['by'], $f['charged']]);
}

function upload_file(array $u, array $req): array {
  $s = find_sub($req['submissionId'] ?? null);
  if (!$s) throw new ApiError('Please save the committee details before uploading files');
  $kind = ($req['kind'] ?? '') === 'photo' ? 'photo' : 'document';
  if ($kind === 'photo' && count_kind($s['id'], 'photo') >= LIMITS['MAX_PHOTOS']) throw new ApiError('Maximum ' . LIMITS['MAX_PHOTOS'] . ' photos per committee');
  $mime = (string) ($req['mimeType'] ?? 'application/octet-stream');
  if (!preg_match('/^(image\/(jpeg|png|webp)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-excel|text\/plain)$/', $mime))
    throw new ApiError('File type not allowed: ' . $mime);
  $bytes = base64_decode((string) ($req['base64'] ?? ''), true);
  if (!$bytes) throw new ApiError('Empty file');
  if (strlen($bytes) > LIMITS['MAX_UPLOAD_MB'] * 1048576) throw new ApiError('File is larger than ' . LIMITS['MAX_UPLOAD_MB'] . ' MB');
  check_storage(charge_to($u, $s), strlen($bytes));
  if (!drive_folder_ok($s['folderId'])) throw new ApiError('Committee folder missing — please save the details again');
  $fileName = ($kind === 'photo' ? 'Photo_' : 'Doc_') . ist_stamp('Ymd-His') . '_' . safe_name((string) ($req['name'] ?? ''), 'file');
  $d = drive_upload($bytes, $mime, $fileName, $s['folderId'], 'Uploaded by ' . $u['email'] . ' via Jury App');
  $sizeKB = (int) round(strlen($bytes) / 1024);
  $m = $kind === 'photo' ? clean_meta($req) : clean_meta([]);
  insert_file(['id' => $d['id'], 'email' => $s['email'], 'name' => $fileName, 'mime' => $mime, 'kind' => $kind, 'size_kb' => $sizeKB,
    'url' => $d['webViewLink'] ?? ('https://drive.google.com/file/d/' . $d['id'] . '/view'), 'sub' => $s['id'], 'm' => $m,
    'original_kb' => (int) round(((float) ($req['originalSize'] ?? 0) ?: strlen($bytes)) / 1024), 'compressed' => false, 'by' => $u['email'], 'charged' => charge_to($u, $s)]);
  if ($kind === 'photo') {   // the phone already has this photo; keep a copy for other viewers' gallery
    $dir = private_dir() . '/cache';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    @file_put_contents($dir . '/' . preg_replace('/[^\w-]/', '', $d['id']), $bytes); @file_put_contents($dir . '/' . preg_replace('/[^\w-]/', '', $d['id']) . '.type', $mime);
  }
  log_act($u, 'UPLOAD', $s['committee'] . ' — ' . $kind . ': ' . $fileName . ' (' . $sizeKB . ' KB)' . contrib_note($u, $s));
  return files_reply($u, $s);
}

/* ---- videos: 5 MB pieces streamed into a Drive resumable upload ---- */
function put_upload(string $id, array $up): void { q('REPLACE INTO uploads (id, data, expires) VALUES (?, ?, ?)', [$id, json_encode($up), time() + UPLOAD_TTL]); }
function get_upload(string $id, array $u): array {
  $r = q('SELECT data FROM uploads WHERE id = ? AND expires > ?', [$id, time()])->fetch();
  if (!$r) throw new ApiError('Video upload expired — please upload it again');
  $up = json_decode($r['data'], true);
  if ($up['by'] !== $u['email']) throw new ApiError('Video upload not found');
  return $up;
}
function upload_start(array $u, array $req): array {
  $s = find_sub($req['submissionId'] ?? null);
  if (!$s) throw new ApiError('Please save the committee details before uploading files');
  $mime = (string) ($req['mimeType'] ?? '');
  if (!preg_match('/^video\/[\w.+-]+$/', $mime)) throw new ApiError('Only video files can be uploaded here');
  $size = (int) ($req['size'] ?? 0);
  if ($size <= 0) throw new ApiError('Empty file');
  if ($size > LIMITS['MAX_VIDEO_MB'] * 1048576) throw new ApiError('Video is larger than ' . LIMITS['MAX_VIDEO_MB'] . ' MB');
  if (count_kind($s['id'], 'video') >= LIMITS['MAX_VIDEOS']) throw new ApiError('Maximum ' . LIMITS['MAX_VIDEOS'] . ' videos per committee');
  check_storage(charge_to($u, $s), $size);
  if (!drive_folder_ok($s['folderId'])) throw new ApiError('Committee folder missing — please save the details again');
  $fileName = 'Video_' . ist_stamp('Ymd-His') . '_' . safe_name((string) ($req['name'] ?? ''), 'video');
  [$code, $h] = drive('POST', DRIVE_UP . '?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink', [
    'body' => json_encode(['name' => $fileName, 'parents' => [$s['folderId']], 'description' => 'Uploaded by ' . $u['email'] . ' via Jury App']),
    'headers' => ['Content-Type: application/json; charset=UTF-8', 'X-Upload-Content-Type: ' . $mime, 'X-Upload-Content-Length: ' . $size]]);
  if ($code !== 200 || empty($h['location'])) throw new ApiError('Could not start the video upload (' . $code . '). Please try again.');
  $uploadId = new_id('U', 32);
  put_upload($uploadId, ['url' => $h['location'], 'sub' => $s['id'], 'by' => $u['email'], 'name' => $fileName, 'mime' => $mime, 'size' => $size,
    'meta' => clean_meta($req), 'originalSize' => (int) ($req['originalSize'] ?? 0) ?: $size, 'compressed' => ($req['compressed'] ?? false) === true, 'charged' => charge_to($u, $s)]);
  log_act($u, 'UPLOAD_STARTED', $s['committee'] . ' — video: ' . $fileName . ' (' . round($size / 1048576) . ' MB' . (($req['compressed'] ?? false) === true ? ', compressed' : '') . ')');
  return ['ok' => true, 'uploadId' => $uploadId, 'chunkSize' => VIDEO_CHUNK, 'received' => 0];
}
function upload_chunk(array $u, array $req): array {
  $id = (string) ($req['uploadId'] ?? ''); $up = get_upload($id, $u);
  if (!empty($up['done'])) return finished_upload($up, $u);
  $bytes = base64_decode((string) ($req['base64'] ?? ''), true);
  $start = (int) ($req['offset'] ?? 0); $end = $start + strlen((string) $bytes) - 1;
  if (!$bytes || $end >= $up['size']) throw new ApiError('Video upload got out of step — please try again');
  $res = drive('PUT', $up['url'], ['body' => $bytes, 'headers' => ['Content-Type: ' . $up['mime'], 'Content-Range: bytes ' . $start . '-' . $end . '/' . $up['size']], 'timeout' => 120]);
  return drive_reply($id, $up, $res, $u);
}
function upload_status(array $u, array $req): array {
  $id = (string) ($req['uploadId'] ?? ''); $up = get_upload($id, $u);
  if (!empty($up['done'])) return finished_upload($up, $u);
  return drive_reply($id, $up, drive('PUT', $up['url'], ['body' => '', 'headers' => ['Content-Range: bytes */' . $up['size']]]), $u);
}
function upload_cancel(array $u, array $req): array {
  $id = (string) ($req['uploadId'] ?? '');
  $r = q('SELECT data FROM uploads WHERE id = ?', [$id])->fetch();
  if (!$r) return ['ok' => true];
  $up = json_decode($r['data'], true);
  if ($up['by'] !== $u['email']) throw new ApiError('Video upload not found');
  if (empty($up['done'])) { try { drive('DELETE', $up['url']); } catch (Throwable $e) {} log_act($u, 'UPLOAD_CANCELLED', $up['name']); }
  q('DELETE FROM uploads WHERE id = ?', [$id]);
  return ['ok' => true];
}
function drive_reply(string $id, array $up, array $res, array $u): array {
  [$code, $h, $body] = $res;
  if ($code === 308) {
    put_upload($id, $up);
    return ['ok' => true, 'done' => false, 'received' => preg_match('/bytes=0-(\d+)/', $h['range'] ?? '', $m) ? (int) $m[1] + 1 : 0];
  }
  if ($code === 404 || $code === 410) { q('DELETE FROM uploads WHERE id = ?', [$id]); throw new ApiError('Video upload expired — please upload it again'); }
  if ($code !== 200 && $code !== 201) throw new ApiError('Video upload failed (' . $code . '). Please try again.');
  $meta = json_decode($body, true) ?: [];
  $s = find_sub($up['sub']); $sizeKB = (int) round($up['size'] / 1024);
  insert_file(['id' => $meta['id'], 'email' => $s['email'], 'name' => $up['name'], 'mime' => $up['mime'], 'kind' => 'video', 'size_kb' => $sizeKB,
    'url' => $meta['webViewLink'] ?? ('https://drive.google.com/file/d/' . $meta['id'] . '/view'), 'sub' => $s['id'], 'm' => $up['meta'],
    'original_kb' => (int) round($up['originalSize'] / 1024), 'compressed' => !empty($up['compressed']), 'by' => $up['by'], 'charged' => $up['charged'] ?: $s['email']]);
  log_act($u, 'UPLOAD', $s['committee'] . ' — video: ' . $up['name'] . ' (' . $sizeKB . ' KB' .
    (!empty($up['compressed']) ? ', compressed from ' . round($up['originalSize'] / 1024) . ' KB' : '') . ')' . contrib_note($u, $s));
  $up['done'] = true; $up['fileId'] = $meta['id'];
  put_upload($id, $up);   // a retried last piece must not add the file twice
  return finished_upload($up, $u);
}
function finished_upload(array $up, array $u): array { $r = files_reply($u, find_sub($up['sub'])); $r['done'] = true; $r['fileId'] = $up['fileId']; return $r; }

function update_file_meta(array $u, array $req): array {
  $r = find_file($req['fileId'] ?? null);
  if (!$r || $r['deleted'] || !can_manage_file($u, $r)) throw new ApiError('File not found');
  $m = clean_meta($req);
  q('UPDATE files SET caption = ?, sections = ? WHERE id = ?', [$m['caption'], $m['sections'], $r['id']]);
  if (!empty($req['clearLocation'])) q('UPDATE files SET lat = NULL, lng = NULL WHERE id = ?', [$r['id']]);
  elseif ($m['lat'] !== null) q('UPDATE files SET lat = ?, lng = ? WHERE id = ?', [$m['lat'], $m['lng'], $r['id']]);
  log_act($u, 'FILE_DETAILS', $r['name'] . ($m['sections'] ? ' — sections ' . $m['sections'] : '') . ($m['caption'] ? ' — captioned' : ''));
  return files_reply($u, find_sub($r['submission_id']));
}

function delete_file(array $u, array $req): array {
  $r = find_file($req['fileId'] ?? null);
  if (!$r || $r['deleted'] || !can_manage_file($u, $r)) throw new ApiError('File not found');
  drive_trash($r['id']);
  q('UPDATE files SET deleted = 1, thumb = NULL WHERE id = ?', [$r['id']]);
  log_act($u, 'FILE_DELETED', $r['name'] . ($r['uploaded_by'] !== $u['email'] ? ' (added by ' . $r['uploaded_by'] . ')' : ''));
  $reply = files_reply($u, find_sub($r['submission_id']));
  $reply['storage'] = storage_info($u['role'] === 'admin' ? $r['charged_to'] : $u['email']);
  return $reply;
}

function get_file(array $u, array $req): array {
  $r = find_file($req['fileId'] ?? null);
  if (!$r || $r['deleted'] || !can_manage_file($u, $r)) throw new ApiError('File not found');
  [$bytes, $type] = drive_media($r['id']);
  return ['ok' => true, 'mimeType' => $type, 'base64' => base64_encode($bytes)];
}

/** Previews of up to 30 photos / videos in one request, stored in MySQL after the first time. */
function get_thumbs(array $u, array $req): array {
  $ids = array_slice(array_map('strval', is_array($req['ids'] ?? null) ? $req['ids'] : []), 0, 30);
  $out = []; $todo = [];
  foreach ($ids as $id) {
    $r = find_file($id);
    if (!$r || $r['deleted'] || !can_manage_file($u, $r)) continue;
    if ($r['thumb']) $out[$id] = $r['thumb']; else { $out[$id] = null; $todo[] = $id; }
  }
  foreach (drive_thumbs($todo) as $id => $url) {
    $out[$id] = $url;
    q('UPDATE files SET thumb = ? WHERE id = ?', [$url, $id]);
  }
  return ['ok' => true, 'thumbs' => (object) $out];
}

/* =================================================================
 *  ADMIN
 * ================================================================= */
function admin_list(): array {
  $users = all_users(true); $subs = all_subs(); $byEmail = [];
  foreach ($subs as $s) $byEmail[$s['email']][] = $s;
  $counts = file_counts(); $usedKB = [];
  foreach (q('SELECT charged_to, SUM(size_kb) kb FROM files WHERE deleted = 0 GROUP BY charged_to')->fetchAll() as $r) $usedKB[$r['charged_to']] = (float) $r['kb'];
  $list = array_map(function ($u) use ($byEmail, $counts, $usedKB) {
    $ss = $byEmail[$u['email']] ?? []; $p = $v = $d = $sub = 0; $upd = '';
    foreach ($ss as $s) {
      $c = $counts[$s['id']] ?? ['photo' => 0, 'video' => 0, 'document' => 0];
      $p += $c['photo']; $v += $c['video']; $d += $c['document'];
      if ($s['status'] === 'Submitted') $sub++;
      if (iso($s['updatedAt']) > $upd) $upd = iso($s['updatedAt']);
    }
    $kb = $usedKB[$u['email']] ?? 0;
    return ['email' => $u['email'], 'name' => $u['name'], 'phone' => $u['phone'], 'role' => $u['role'], 'active' => $u['active'],
      'pending' => $u['pending'], 'rejected' => $u['rejected'], 'team' => $u['team'], 'assignedArea' => $u['area'],
      'altEmail' => $u['altEmail'], 'reference' => $u['reference'], 'source' => $u['source'], 'lastLogin' => iso($u['lastLogin']),
      'committees' => count($ss), 'submitted' => $sub, 'status' => !$ss ? 'Not started' : ($sub ? 'Submitted' : 'Draft'),
      'location' => implode(', ', array_filter(array_map(fn($s) => (string) $s['location'], $ss))), 'memberName' => $u['name'], 'updatedAt' => $upd,
      'photos' => $p, 'videos' => $v, 'documents' => $d, 'storageMB' => round($kb / 1024, 1),
      'storageWarn' => $kb >= LIMITS['MEMBER_QUOTA_MB'] * 1024 * LIMITS['STORAGE_WARN_PCT'] / 100];
  }, $users);
  try { $q = drive_quota(); } catch (Throwable $e) { $q = ['limit' => 0, 'usage' => 0]; }
  $free = $q['limit'] > 0 ? round(($q['limit'] - $q['usage']) / 1048576) : null;
  $drive = ['usedMB' => round($q['usage'] / 1048576), 'limitMB' => $q['limit'] > 0 ? round($q['limit'] / 1048576) : null, 'freeMB' => $free,
    'reserveMB' => LIMITS['MIN_FREE_MB'], 'quotaMB' => LIMITS['MEMBER_QUOTA_MB'],
    'low' => $free !== null && $free < LIMITS['MIN_FREE_MB'] * 2, 'paused' => $free !== null && $free < LIMITS['MIN_FREE_MB']];
  $names = user_names();
  $committees = array_map(function ($c) use ($names) { $c['memberName'] = ($names[$c['email']] ?? '') ?: $c['memberName']; return $c; }, summaries($subs, true));
  return ['ok' => true, 'members' => $list, 'committees' => $committees, 'drive' => $drive];
}
function admin_get(array $u, array $req): array {
  $email = norm($req['email'] ?? ''); $t = find_user($email);
  return ['ok' => true, 'user' => $t ? public_user($t) : ['email' => $email], 'submissions' => summaries(subs_for($email), true)];
}
function admin_log(array $u, array $req): array {
  $limit = min((int) ($req['limit'] ?? 200) ?: 200, 1000);
  $rows = q('SELECT ts, email, name, action, details FROM activity_log ORDER BY id DESC LIMIT ' . $limit)->fetchAll();
  return ['ok' => true, 'log' => array_map(fn($r) => ['time' => iso($r['ts']), 'email' => $r['email'], 'name' => $r['name'], 'action' => $r['action'], 'details' => $r['details']], $rows)];
}
function admin_set_role(array $u, array $req): array {
  $t = find_user(norm($req['email'] ?? ''));
  if (!$t) throw new ApiError('User not found');
  $role = ($req['role'] ?? '') === 'admin' ? 'admin' : 'jury';
  if ($t['email'] === $u['email'] && $role !== 'admin') throw new ApiError('You cannot remove your own admin access');
  q('UPDATE users SET role = ? WHERE login = ?', [$role, $t['email']]);
  sheet_change($t['email'], 'set', ['D' => $role]);
  log_act($u, 'ADMIN_ROLE_SET', $t['email'] . ' ' . $t['name'] . ' → ' . $role);
  return admin_list();
}
function admin_approve(array $u, array $req): array {
  $t = find_user(norm($req['email'] ?? ''));
  if (!$t) throw new ApiError('User not found');
  $approve = ($req['approve'] ?? true) !== false;
  $role = ($req['role'] ?? '') === 'admin' ? 'admin' : 'jury';
  if ($approve) { q('UPDATE users SET active = ?, role = ? WHERE login = ?', ['TRUE', $role, $t['email']]); sheet_change($t['email'], 'set', ['H' => true, 'D' => $role]); }
  else { q('UPDATE users SET active = ? WHERE login = ?', ['REJECTED', $t['email']]); sheet_change($t['email'], 'set', ['H' => 'REJECTED']); }
  log_act($u, $approve ? 'ADMIN_APPROVED' : 'ADMIN_REJECTED', $t['email'] . ' ' . $t['name'] . ($approve ? ' as ' . $role : ''));
  if ($approve && $t['altEmail'] !== '') {
    $h = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES);
    queue_mail($t['altEmail'], 'Your Paribesh Bandhu Jury Portal access is approved', '<p>Hello ' . $h($t['name']) . ',</p><p>Your jury registration is approved.</p>' .
      '<p>Open <a href="https://pbs.mantrasfoundation.org">pbs.mantrasfoundation.org</a> and log in with your mobile number <b>' . $h($t['phone'] ?: $t['email']) . '</b>.</p>', true);
  }
  return admin_list();
}

/* =================================================================
 *  SELF-REGISTRATION (needs admin approval)
 * ================================================================= */
function register(array $req): array {
  $name = cut(trim((string) ($req['name'] ?? '')), 100);
  $phone = norm($req['phone'] ?? '');
  $email = cut(strtolower(trim((string) ($req['emailAddr'] ?? ''))), 120);
  $area = cut(trim((string) ($req['area'] ?? '')), 200);
  $ref = cut(trim((string) ($req['reference'] ?? '')), 120);
  if ($name === '') return ['ok' => false, 'error' => 'Enter your full name'];
  if (!preg_match('/^\d{10}$/', $phone)) return ['ok' => false, 'error' => 'Enter a valid 10-digit mobile number'];
  if ($email !== '' && !preg_match('/^[^@\s]+@[^@\s]+\.[^@\s]+$/', $email)) return ['ok' => false, 'error' => 'Enter a valid email or leave it blank'];
  if ($area === '') return ['ok' => false, 'error' => 'Enter the area you will visit'];
  if (kv_get('reg_' . $phone)) return ['ok' => false, 'error' => 'Already submitted. Please wait for approval.'];
  $existing = find_user($phone) ?: ($email !== '' ? find_user($email) : null);
  if ($existing) return ['ok' => false, 'error' => $existing['pending'] ? 'You have already registered. Approval is pending.' : 'This number is already registered. Log in with your mobile number.'];
  $source = 'Self-registered ' . ist_stamp('d-M-Y H:i');
  q('INSERT INTO users (login, col_a, name, phone, role, active, area, source, alt_email, reference) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [$phone, $phone, $name, $phone, 'jury', 'PENDING', $area, $source, $email, $ref]);
  sheet_change($phone, 'append', ['A' => $phone, 'B' => $name, 'C' => $phone, 'D' => 'jury', 'H' => 'PENDING', 'K' => $area, 'M' => $source, 'N' => $email, 'O' => $ref]);
  kv_set('reg_' . $phone, '1', time() + 600);
  log_act(['email' => $phone, 'name' => $name], 'REGISTERED', 'Area: ' . $area . ($ref !== '' ? ' | Ref: ' . $ref : ''));
  queue_mail('', 'New jury registration: ' . $name, $name . ' (' . $phone . ($email !== '' ? ', ' . $email : '') . ') registered for ' . $area .
    ($ref !== '' ? ' — referred by ' . $ref : '') . ".\n\nApprove it in the Admin dashboard of the Jury Portal.");   // '' = the organisers' address (set in Apps Script)
  return ['ok' => true, 'message' => 'Registration received. You will be able to log in once the organisers approve it.'];
}
