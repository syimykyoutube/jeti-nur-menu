import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.dev.vars')) {
  console.log('.dev.vars мурда түзүлгөн. Файл өзгөртүлгөн жок.');
} else {
  const example = readFileSync('.dev.vars.example', 'utf8');
  const contents = example.replace('PASSWORD_VIEW_KEY=""', `PASSWORD_VIEW_KEY="${randomBytes(32).toString('base64url')}"`);
  writeFileSync('.dev.vars', contents, { flag: 'wx', mode: 0o600 });
  console.log('.dev.vars түзүлдү. Эми ошол файлга SETUP_LOGIN жана SETUP_PASSWORD маанилерин өзүңүз жазыңыз. Ачкыч экранга чыгарылган жок.');
}
