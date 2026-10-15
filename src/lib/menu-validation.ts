import type { ItemInput, SqlBoolean, VariantInput } from '../db/types';
import { validateName } from '../db/admin';
import { AppError } from './errors';

export const MAX_VARIANTS = 50;

export interface ItemFormValues {
  image_key?: string;
  name_ky: string;
  name_ru: string;
  category_id: string;
  ingredients_ky: string;
  ingredients_ru: string;
  is_available: SqlBoolean;
  variants: { label: string; price: string }[];
}

function strings(form: Record<string, unknown>, key: string): string[] {
  const value = form[key];
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((entry) => typeof entry === 'string')) throw new AppError(400, 'invalidForm');
  return values as string[];
}

function single(form: Record<string, unknown>, key: string): string {
  const values = strings(form, key);
  if (values.length > 1) throw new AppError(400, 'invalidForm');
  return values[0] ?? '';
}

export function readItemValues(form: Record<string, unknown>, existing?: ItemFormValues): ItemFormValues {
  let prices = strings(form, 'variant_price');
  let labels = strings(form, 'variant_label');
  // Keep the earlier single-variant and metadata endpoints compatible.
  const fullForm = single(form, 'variants_form');
  if (fullForm && fullForm !== '1') throw new AppError(400, 'invalidForm');
  if (prices.length === 0 && labels.length === 0 && fullForm !== '1') {
    if (form.price !== undefined) {
      prices = [single(form, 'price')]; labels = [single(form, 'label')];
    } else if (existing) {
      prices = existing.variants.map((variant) => variant.price);
      labels = existing.variants.map((variant) => variant.label);
    }
  }
  if (prices.length !== labels.length) throw new AppError(400, 'invalidVariants');
  const available = single(form, 'is_available') || (existing ? '0' : '1');
  if (available !== '0' && available !== '1') throw new AppError(400, 'invalidForm');
  return {
    image_key: form.image_key === undefined ? existing?.image_key ?? '' : single(form, 'image_key'),
    name_ky: single(form, 'name_ky'), name_ru: single(form, 'name_ru'), category_id: single(form, 'category_id'),
    ingredients_ky: single(form, 'ingredients_ky'), ingredients_ru: single(form, 'ingredients_ru'),
    is_available: available === '1' ? 1 : 0,
    variants: prices.map((price, index) => ({ price, label: labels[index] })),
  };
}

export function validateVariant(label: string, price: string, sortOrder = 0): VariantInput {
  if (label.trim().length > 40) throw new AppError(400, 'invalidVariantLabel');
  if (!/^[0-9]+$/.test(price) || !Number.isSafeInteger(Number(price))) throw new AppError(400, 'invalidPrice');
  return { label: label.trim(), price: Number(price), sort_order: sortOrder };
}

export function validateItemValues(values: ItemFormValues): ItemInput {
  if (!/^[1-9][0-9]*$/.test(values.category_id) || !Number.isSafeInteger(Number(values.category_id))) throw new AppError(400, 'invalidCategory');
  if (values.ingredients_ky.length > 2000 || values.ingredients_ru.length > 2000) throw new AppError(400, 'invalidIngredients');
  if (values.variants.length < 1) throw new AppError(400, 'invalidVariants');
  if (values.variants.length > MAX_VARIANTS) throw new AppError(400, 'tooManyVariants');
  return {
    name_ky: validateName(values.name_ky), name_ru: values.name_ru.trim() ? validateName(values.name_ru) : null,
    category_id: Number(values.category_id), ingredients_ky: values.ingredients_ky.trim() || null, ingredients_ru: values.ingredients_ru.trim() || null,
    is_available: values.is_available,
    variants: values.variants.map((variant, index) => validateVariant(variant.label, variant.price, index)),
  };
}
