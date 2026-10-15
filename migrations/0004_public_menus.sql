-- Public requests read one indexed row, without joining cafes or rebuilding HTML.
ALTER TABLE published_menus ADD COLUMN slug TEXT;
ALTER TABLE published_menus ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1));
UPDATE published_menus SET slug = (SELECT slug FROM cafes WHERE id = cafe_id),
  is_active = (SELECT is_active FROM cafes WHERE id = cafe_id);
CREATE UNIQUE INDEX idx_published_menus_slug ON published_menus(slug);

-- Pause/rename takes effect even while the next HTML snapshot is being rendered.
CREATE TRIGGER cafes_sync_public_access
AFTER UPDATE OF slug, is_active ON cafes
BEGIN
  UPDATE published_menus SET slug = NEW.slug, is_active = NEW.is_active,
    updated_at = CURRENT_TIMESTAMP WHERE cafe_id = NEW.id;
END;
