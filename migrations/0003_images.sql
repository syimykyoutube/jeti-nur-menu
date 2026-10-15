-- A key is claimed exactly once, in the same D1 transaction as its menu reference.
-- Retired objects stay queued until R2 deletion succeeds; failed forms keep staged uploads.
CREATE TABLE image_uploads (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  cafe_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('item', 'logo')),
  state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'attached', 'retired')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX image_uploads_cleanup ON image_uploads (cafe_id, state, created_at);

-- Keep any references already present before this migration.
INSERT OR IGNORE INTO image_uploads (key, cafe_id, kind, state)
SELECT image_key, cafe_id, 'item', 'attached' FROM items WHERE image_key IS NOT NULL;
INSERT OR IGNORE INTO image_uploads (key, cafe_id, kind, state)
SELECT logo_key, id, 'logo', 'attached' FROM cafes WHERE logo_key IS NOT NULL;

CREATE TRIGGER items_validate_image_insert
BEFORE INSERT ON items
WHEN NEW.image_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid_image_reference') WHERE NOT EXISTS (
    SELECT 1 FROM image_uploads WHERE key = NEW.image_key AND cafe_id = NEW.cafe_id
      AND kind = 'item' AND state = 'staged'
  );
END;
CREATE TRIGGER items_claim_image_insert
AFTER INSERT ON items
WHEN NEW.image_key IS NOT NULL
BEGIN
  UPDATE image_uploads SET state = 'attached', updated_at = CURRENT_TIMESTAMP WHERE key = NEW.image_key;
END;

CREATE TRIGGER items_validate_image_update
BEFORE UPDATE ON items
WHEN NEW.image_key IS NOT NULL AND NEW.image_key IS NOT OLD.image_key
BEGIN
  SELECT RAISE(ABORT, 'invalid_image_reference') WHERE NOT EXISTS (
    SELECT 1 FROM image_uploads WHERE key = NEW.image_key AND cafe_id = NEW.cafe_id
      AND kind = 'item' AND state = 'staged'
  );
END;
CREATE TRIGGER items_claim_image_update
AFTER UPDATE ON items
WHEN NEW.image_key IS NOT NULL AND NEW.image_key IS NOT OLD.image_key
BEGIN
  UPDATE image_uploads SET state = 'attached', updated_at = CURRENT_TIMESTAMP WHERE key = NEW.image_key;
END;

CREATE TRIGGER items_retire_image_update
AFTER UPDATE ON items
WHEN OLD.image_key IS NOT NULL AND OLD.image_key IS NOT NEW.image_key
BEGIN
  UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP WHERE key = OLD.image_key;
END;
CREATE TRIGGER items_retire_image_delete
AFTER DELETE ON items
WHEN OLD.image_key IS NOT NULL
BEGIN
  UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP WHERE key = OLD.image_key;
END;

CREATE TRIGGER cafes_validate_image_insert
BEFORE INSERT ON cafes
WHEN NEW.logo_key IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'invalid_image_reference') WHERE NOT EXISTS (
    SELECT 1 FROM image_uploads WHERE key = NEW.logo_key AND cafe_id = NEW.id
      AND kind = 'logo' AND state = 'staged'
  );
END;
CREATE TRIGGER cafes_claim_image_insert
AFTER INSERT ON cafes
WHEN NEW.logo_key IS NOT NULL
BEGIN
  UPDATE image_uploads SET state = 'attached', updated_at = CURRENT_TIMESTAMP WHERE key = NEW.logo_key;
END;

CREATE TRIGGER cafes_validate_image_update
BEFORE UPDATE ON cafes
WHEN NEW.logo_key IS NOT NULL AND NEW.logo_key IS NOT OLD.logo_key
BEGIN
  SELECT RAISE(ABORT, 'invalid_image_reference') WHERE NOT EXISTS (
    SELECT 1 FROM image_uploads WHERE key = NEW.logo_key AND cafe_id = NEW.id
      AND kind = 'logo' AND state = 'staged'
  );
END;
CREATE TRIGGER cafes_claim_image_update
AFTER UPDATE ON cafes
WHEN NEW.logo_key IS NOT NULL AND NEW.logo_key IS NOT OLD.logo_key
BEGIN
  UPDATE image_uploads SET state = 'attached', updated_at = CURRENT_TIMESTAMP WHERE key = NEW.logo_key;
END;

CREATE TRIGGER cafes_retire_image_update
AFTER UPDATE ON cafes
WHEN OLD.logo_key IS NOT NULL AND OLD.logo_key IS NOT NEW.logo_key
BEGIN
  UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP WHERE key = OLD.logo_key;
END;
CREATE TRIGGER cafes_retire_image_delete
AFTER DELETE ON cafes
WHEN OLD.logo_key IS NOT NULL
BEGIN
  UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP WHERE key = OLD.logo_key;
END;

CREATE TRIGGER cafes_retire_pending_images
AFTER DELETE ON cafes
BEGIN
  UPDATE image_uploads SET state = 'retired', updated_at = CURRENT_TIMESTAMP WHERE cafe_id = OLD.id;
END;
