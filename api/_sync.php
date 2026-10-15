<?php
/* Endpoints for the Apps Script (Sync.gs) only — protected by the shared key, never called by the app.
 *   syncStart   app changes to copy into the Users sheet + emails to send
 *   syncFinish  confirms those, takes the Users sheet rows + a fresh Drive token, returns the other tabs' rows
 *   syncImport  one-time copy of Submissions / Files / ActivityLog from the sheet */
declare(strict_types=1);

function sync_route(string $action, array $req): array {
  if (!cfg('gas_key') || !hash_equals((string) cfg('gas_key'), (string) ($req['key'] ?? ''))) throw new ApiError('Not permitted');
  if ($action === 'syncStart') {
    return ['ok' => true,
      'changes' => array_map(fn($r) => ['id' => (int) $r['id'], 'login' => $r['login'], 'op' => $r['op'], 'cols' => json_decode($r['cols'], true)],
        q('SELECT id, login, op, cols FROM user_changes ORDER BY id LIMIT 500')->fetchAll()),
      'mails' => array_map(fn($r) => ['id' => (int) $r['id'], 'to' => $r['to_addr'], 'subject' => $r['subject'], 'body' => $r['body'], 'html' => (bool) $r['html']],
        q('SELECT * FROM mail_queue ORDER BY id LIMIT 50')->fetchAll())];
  }
  if ($action === 'syncFinish') {
    $ids = array_map('intval', $req['applied'] ?? []);
    if ($ids) q('DELETE FROM user_changes WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')', $ids);
    $mails = array_map('intval', $req['mailsSent'] ?? []);
    if ($mails) q('DELETE FROM mail_queue WHERE id IN (' . implode(',', array_fill(0, count($mails), '?')) . ')', $mails);
    if (!empty($req['token'])) kv_set('drive_token', (string) $req['token'], time() + 45 * 60);
    if (!empty($req['rootFolderId'])) kv_set('root_folder_id', (string) $req['rootFolderId'], 0);
    $n = is_array($req['users'] ?? null) ? upsert_users($req['users']) : 0;
    return ['ok' => true, 'usersUpdated' => $n, 'export' => export_rows()];
  }
  if ($action === 'syncImport') return import_rows($req);
  throw new ApiError('Unknown action');
}

/** Users sheet rows (A..O, no header) → users table. The sheet is the master list, except for users with app changes
 *  not yet copied into the sheet (their DB values are newer). Users missing from the sheet are left alone. */
function upsert_users(array $rows): int {
  $pending = array_flip(q('SELECT DISTINCT login FROM user_changes')->fetchAll(PDO::FETCH_COLUMN));
  $n = 0;
  foreach ($rows as $r) {
    if (!is_array($r)) continue;
    $c = fn(int $i) => trim(scalar_str($r[$i] ?? ''));
    $login = norm($r[0] ?? '');
    if ($login === '' || isset($pending[$login])) continue;
    $sheetLogin = to_db_date($r[8] ?? '');
    q('INSERT INTO users (login, col_a, name, phone, role, active, last_login, team, area, alternate, source, alt_email, reference)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE col_a = VALUES(col_a), name = VALUES(name), phone = VALUES(phone), role = VALUES(role), active = VALUES(active),
         last_login = GREATEST(COALESCE(last_login, VALUES(last_login)), COALESCE(VALUES(last_login), last_login)),
         team = VALUES(team), area = VALUES(area), alternate = VALUES(alternate), source = VALUES(source), alt_email = VALUES(alt_email), reference = VALUES(reference)',
      [$login, cut($c(0), 190), cut($c(1), 200), cut($c(2), 60), cut($c(3), 30), cut($c(7), 30), $sheetLogin, cut($c(9), 200), cut($c(10), 255),
        cut($c(11), 100), cut($c(12), 255), cut(strtolower($c(13)), 190), cut($c(14), 255)]);
    $n++;
  }
  return $n;
}

/** Current Submissions / Files / ActivityLog as sheet rows (same columns as before), for the back-office tabs. */
function export_rows(): array {
  return [
    'Submissions' => array_map(fn($r) => [$r['email'], $r['member_name'], $r['location'], $r['folder_id'], $r['folder_url'], (string) $r['data'], $r['status'],
      iso($r['created_at']), iso($r['updated_at']), $r['id'], $r['committee']], q('SELECT * FROM submissions ORDER BY seq')->fetchAll()),
    'Files' => array_map(fn($r) => [$r['id'], $r['email'], $r['name'], $r['mime'], $r['kind'], (int) $r['size_kb'], iso($r['uploaded_at']), $r['url'], (bool) $r['deleted'],
      $r['submission_id'], $r['caption'], $r['sections'], $r['captured_at'], $r['capture_source'], $r['lat'] ?? '', $r['lng'] ?? '', (int) $r['original_kb'],
      (bool) $r['compressed'], $r['uploaded_by'], $r['charged_to']],
      q('SELECT id, email, name, mime, kind, size_kb, uploaded_at, url, deleted, submission_id, caption, sections, captured_at, capture_source, lat, lng, original_kb, compressed, uploaded_by, charged_to FROM files ORDER BY seq')->fetchAll()),
    'ActivityLog' => array_map(fn($r) => [iso($r['ts']), $r['email'], $r['name'], $r['action'], $r['details']],
      q('SELECT ts, email, name, action, details FROM activity_log ORDER BY id')->fetchAll()),
  ];
}

/** One-time import of the sheet's Submissions / Files / ActivityLog tabs (rows without the header). */
function import_rows(array $req): array {
  $have = (int) q('SELECT (SELECT COUNT(*) FROM submissions) + (SELECT COUNT(*) FROM files)')->fetchColumn();
  if ($have && empty($req['force'])) throw new ApiError('Data already imported (run with force to replace it)');
  $pdo = db();
  $pdo->beginTransaction();
  try {
    if (!empty($req['force'])) { $pdo->exec('DELETE FROM submissions'); $pdo->exec('DELETE FROM files'); $pdo->exec('DELETE FROM activity_log'); }
    $s = 0; $f = 0; $l = 0;
    foreach ($req['submissions'] ?? [] as $r) {
      if (scalar_str($r[0] ?? '') === '') continue;
      $data = scalar_str($r[5] ?? '') ?: '{}';
      $d = json_decode($data, true) ?: [];
      q('INSERT INTO submissions (id, email, member_name, location, folder_id, folder_url, data, status, created_at, updated_at, committee) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [scalar_str($r[9] ?? '') ?: new_id('S', 12), norm($r[0]), cut(scalar_str($r[1] ?? ''), 255), cut(scalar_str($r[2] ?? ''), 255), scalar_str($r[3] ?? ''),
          scalar_str($r[4] ?? ''), $data, scalar_str($r[6] ?? '') ?: 'Draft', to_db_date($r[7] ?? ''), to_db_date($r[8] ?? ''),
          cut(scalar_str($r[10] ?? '') ?: (string) ($d['committeeName'] ?? ''), 255)]);
      $s++;
    }
    foreach ($req['files'] ?? [] as $r) {
      $id = scalar_str($r[0] ?? '');
      if ($id === '') continue;
      $num = fn($v) => $v === '' || $v === null || !is_numeric($v) ? null : (float) $v;
      $cap = scalar_str($r[12] ?? '');
      q('INSERT INTO files (id, email, name, mime, kind, size_kb, uploaded_at, url, deleted, submission_id, caption, sections, captured_at, capture_source, lat, lng, original_kb, compressed, uploaded_by, charged_to)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [$id, norm($r[1] ?? ''), cut(scalar_str($r[2] ?? ''), 255), scalar_str($r[3] ?? ''), scalar_str($r[4] ?? ''), (int) ($r[5] ?? 0), to_db_date($r[6] ?? ''),
          scalar_str($r[7] ?? ''), truthy($r[8] ?? '') ? 1 : 0, scalar_str($r[9] ?? ''), cut(scalar_str($r[10] ?? ''), 400), scalar_str($r[11] ?? ''),
          $cap === '' ? '' : (to_db_date($cap) ? iso(to_db_date($cap)) : $cap), scalar_str($r[13] ?? ''), $num($r[14] ?? ''), $num($r[15] ?? ''),
          (int) ($r[16] ?? 0) ?: (int) ($r[5] ?? 0), truthy($r[17] ?? '') ? 1 : 0, norm(scalar_str($r[18] ?? '') ?: ($r[1] ?? '')), norm(scalar_str($r[19] ?? '') ?: ($r[1] ?? ''))]);
      $f++;
    }
    foreach ($req['log'] ?? [] as $r) {
      $ts = to_db_date($r[0] ?? '');
      if (!$ts) continue;
      q('INSERT INTO activity_log (ts, email, name, action, details) VALUES (?,?,?,?,?)',
        [$ts, cut(scalar_str($r[1] ?? ''), 190), cut(scalar_str($r[2] ?? ''), 200), cut(scalar_str($r[3] ?? ''), 40), cut(scalar_str($r[4] ?? ''), 600)]);
      $l++;
    }
    $pdo->commit();
  } catch (Throwable $e) { $pdo->rollBack(); throw $e; }
  return ['ok' => true, 'submissions' => $s, 'files' => $f, 'log' => $l];
}
