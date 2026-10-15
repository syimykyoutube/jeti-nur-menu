-- Only one project owner can complete setup, including concurrent requests.
CREATE UNIQUE INDEX idx_users_single_superadmin ON users(role) WHERE role = 'superadmin';
CREATE UNIQUE INDEX idx_users_one_owner_per_cafe ON users(cafe_id) WHERE role = 'owner';

CREATE TABLE auth_rate_limits (
  ip_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1)
);
CREATE INDEX idx_auth_rate_limits_window ON auth_rate_limits(window_start);

CREATE TRIGGER revoke_sessions_on_credentials_change
AFTER UPDATE OF login, password_hash, role, cafe_id ON users
WHEN OLD.login IS NOT NEW.login OR OLD.password_hash IS NOT NEW.password_hash
  OR OLD.role IS NOT NEW.role OR OLD.cafe_id IS NOT NEW.cafe_id
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
END;

CREATE TRIGGER revoke_sessions_on_cafe_pause
AFTER UPDATE OF is_active ON cafes
WHEN NEW.is_active = 0 AND OLD.is_active <> NEW.is_active
BEGIN
  DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE cafe_id = NEW.id);
END;
