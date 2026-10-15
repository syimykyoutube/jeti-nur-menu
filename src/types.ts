import type { Cafe, Language, User } from './db/types';

export type AuthUser = Pick<User, 'id' | 'login' | 'role' | 'cafe_id' | 'ui_lang'>;

export type AppEnv = {
  Bindings: {
    DB: D1Database;
    IMAGES: R2Bucket;
    PASSWORD_VIEW_KEY?: string;
    SETUP_LOGIN?: string;
    SETUP_PASSWORD?: string;
  };
  Variables: {
    user: AuthUser;
    cafe: Cafe;
    lang: Language;
    nonce: string;
  };
};
