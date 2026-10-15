CREATE TABLE cafes (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 3 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  name_ky TEXT NOT NULL CHECK (length(trim(name_ky)) > 0),
  name_ru TEXT,
  logo_key TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  default_lang TEXT NOT NULL DEFAULT 'ky' CHECK (default_lang IN ('ky', 'ru')),
  menu_version INTEGER NOT NULL DEFAULT 1 CHECK (typeof(menu_version) = 'integer' AND menu_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_cafes_slug ON cafes(slug);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL CHECK (length(login) BETWEEN 3 AND 40),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'owner')),
  cafe_id INTEGER REFERENCES cafes(id) ON DELETE CASCADE,
  ui_lang TEXT NOT NULL DEFAULT 'ky' CHECK (ui_lang IN ('ky', 'ru')),
  password_enc TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((role = 'owner' AND cafe_id IS NOT NULL) OR
         (role = 'superadmin' AND cafe_id IS NULL AND password_enc IS NULL))
);
CREATE UNIQUE INDEX idx_users_login ON users(login);
CREATE INDEX idx_users_cafe_id ON users(cafe_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  name_ky TEXT NOT NULL CHECK (length(trim(name_ky)) > 0),
  name_ru TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_categories_cafe_sort ON categories(cafe_id, sort_order, id);
-- Enables a composite foreign key that prevents assigning another cafe's category.
CREATE UNIQUE INDEX idx_categories_id_cafe_id ON categories(id, cafe_id);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL,
  name_ky TEXT NOT NULL CHECK (length(trim(name_ky)) > 0),
  name_ru TEXT,
  image_key TEXT,
  ingredients_ky TEXT,
  ingredients_ru TEXT,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id, cafe_id) REFERENCES categories(id, cafe_id) ON DELETE NO ACTION
);
CREATE INDEX idx_items_cafe_sort ON items(cafe_id, sort_order, id);
CREATE INDEX idx_items_category_sort ON items(category_id, sort_order, id);

CREATE TABLE item_variants (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (typeof(price) = 'integer' AND price BETWEEN 0 AND 9007199254740991),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_item_variants_item_sort ON item_variants(item_id, sort_order, id);

-- Section 4 explicitly makes cafe_id the primary key of this one-to-one table.
CREATE TABLE published_menus (
  cafe_id INTEGER PRIMARY KEY REFERENCES cafes(id) ON DELETE CASCADE,
  html TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
