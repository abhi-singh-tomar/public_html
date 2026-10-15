<?php
/* TEMPLATE ONLY — no secrets here (this repo is public).
 * Copy to  /home/u918749671/domains/pbs.mantrasfoundation.org/private/pbj-config.php  (outside public_html)
 * and fill in the real values there. */
return [
  'db_host' => 'localhost',
  'db_name' => 'u918749671_pbjury',
  'db_user' => 'u918749671_pbjury',
  'db_pass' => 'PASTE_DATABASE_PASSWORD',

  // long random strings — signs login tokens / shared with the Apps Script (Script Property PHP_KEY)
  'token_secret' => 'PASTE_RANDOM_64_CHARS',
  'gas_key' => 'PASTE_RANDOM_64_CHARS',

  // the Apps Script web app (same URL the app used before)
  'gas_url' => 'https://script.google.com/macros/s/AKfycbyPzjclmWpHI_CaPl2-ilOYRU9T3Hnm-aYeilOD4mijLAStjreANOPc407gBpzE2Qhq/exec',
  // Drive folder that holds every committee folder
  'root_folder_id' => '1MVWM8sAyXDMYDWJ4EZ76YsxyKK_ZCyMa',
];
