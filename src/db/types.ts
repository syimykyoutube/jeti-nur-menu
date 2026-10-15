export type Language = 'ky' | 'ru';
export type SqlBoolean = 0 | 1;

export interface Timestamps {
  /** UTC, SQLite CURRENT_TIMESTAMP format: YYYY-MM-DD HH:MM:SS. */
  created_at: string;
  updated_at: string;
}

export interface Cafe extends Timestamps {
  id: number;
  slug: string;
  name_ky: string;
  name_ru: string | null;
  logo_key: string | null;
  is_active: SqlBoolean;
  default_lang: Language;
  menu_version: number;
}

export interface User extends Timestamps {
  id: number;
  login: string;
  password_hash: string;
  role: 'superadmin' | 'owner';
  cafe_id: number | null;
  ui_lang: Language;
  password_enc: string | null;
}

export interface Session extends Timestamps {
  id: number;
  token_hash: string;
  user_id: number;
  expires_at: string;
}

export interface Category extends Timestamps {
  id: number;
  cafe_id: number;
  name_ky: string;
  name_ru: string | null;
  sort_order: number;
}

export interface Item extends Timestamps {
  id: number;
  cafe_id: number;
  category_id: number;
  name_ky: string;
  name_ru: string | null;
  image_key: string | null;
  ingredients_ky: string | null;
  ingredients_ru: string | null;
  is_available: SqlBoolean;
  sort_order: number;
}

export interface ItemVariant extends Timestamps {
  id: number;
  item_id: number;
  label: string;
  price: number;
  sort_order: number;
}

export interface PublishedMenu extends Timestamps {
  slug: string;
  is_active: SqlBoolean;
  cafe_id: number;
  html: string;
  version: number;
  published_at: string;
}

export type CafeInput = Pick<Cafe, 'slug' | 'name_ky'> &
  Partial<Pick<Cafe, 'name_ru' | 'logo_key' | 'is_active' | 'default_lang'>>;
export type CafePatch = Partial<CafeInput>;
export type CategoryInput = Pick<Category, 'name_ky'> &
  Partial<Pick<Category, 'name_ru' | 'sort_order'>>;
export type CategoryPatch = Partial<CategoryInput>;
export type VariantInput = Pick<ItemVariant, 'price'> &
  Partial<Pick<ItemVariant, 'label' | 'sort_order'>>;
export type VariantPatch = Partial<VariantInput>;
export type ItemFields = Pick<Item, 'category_id' | 'name_ky'> &
  Partial<Pick<Item, 'name_ru' | 'image_key' | 'ingredients_ky' | 'ingredients_ru' | 'is_available' | 'sort_order'>>;
export type ItemInput = ItemFields & { variants: readonly VariantInput[] };
export type ItemPatch = Partial<ItemFields>;
export type ItemWithVariants = Item & { variants: ItemVariant[] };

export type CategoryDeleteAction =
  | { action: 'delete-items' }
  | { action: 'move-items'; targetCategoryId: number };
