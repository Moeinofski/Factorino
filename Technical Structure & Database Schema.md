# Technical Structure & Database Schema

## Invoice Maker PWA — نسخه 1.0

## 1. ساختار فنی پروژه

### Technology Stack

* Frontend: React + TypeScript
* Build Tool: Vite
* Styling: Tailwind CSS
* Routing: React Router
* Local Database: IndexedDB + Dexie.js
* Form Validation: React Hook Form + Zod
* PWA: vite-plugin-pwa
* Testing: Vitest
* Backend: سرویس مستقل برای خرید و مجوز Pro
* Business Data Storage: فقط روی دستگاه کاربر
* Automatic Cloud Sync: خارج از محدوده نسخه MVP

### Project Structure

```text
invoice-maker/
├── public/
│   ├── icons/
│   ├── fonts/
│   └── manifest.webmanifest
│
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── router.tsx
│   │   └── providers.tsx
│   │
│   ├── components/
│   │   ├── ui/
│   │   ├── layout/
│   │   ├── forms/
│   │   └── feedback/
│   │
│   ├── features/
│   │   ├── dashboard/
│   │   ├── invoices/
│   │   ├── customers/
│   │   ├── products/
│   │   ├── payments/
│   │   ├── reports/
│   │   ├── templates/
│   │   ├── settings/
│   │   ├── export-import/
│   │   └── license/
│   │
│   ├── db/
│   │   ├── database.ts
│   │   ├── schema.ts
│   │   ├── migrations.ts
│   │   └── repositories/
│   │
│   ├── services/
│   │   ├── pdf/
│   │   ├── calculations/
│   │   ├── numbering/
│   │   ├── export-import/
│   │   └── licensing/
│   │
│   ├── hooks/
│   ├── types/
│   ├── utils/
│   ├── constants/
│   ├── styles/
│   └── main.tsx
│
├── tests/
│   ├── calculations/
│   ├── database/
│   ├── invoices/
│   └── export-import/
│
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

### قواعد معماری

1. کامپوننت‌های UI مستقیماً با IndexedDB ارتباط برقرار نکنند؛ عملیات داده از طریق Repository انجام شود.
2. محاسبات مالی در سرویس مستقل از UI انجام شوند.
3. تولید PDF به اطلاعات اصلی فاکتور وابسته باشد، نه مقادیر موقت داخل فرم.
4. هر موجودیت یک شناسه پایدار داشته باشد.
5. تغییر ساختار دیتابیس با Migration نسخه‌بندی‌شده انجام شود.
6. کلیدهای محرمانه Backend هرگز در Frontend قرار نگیرند.
7. منطق نسخه رایگان و Pro از منطق اصلی ساخت فاکتور جدا باشد.

---

## 2. مدل دیتابیس

دیتابیس محلی با نام `InvoiceMakerDB` و از نوع IndexedDB خواهد بود که با Dexie.js مدیریت می‌شود.

### 2.1. Store: `customers`

اطلاعات مشتریان.

| فیلد         | نوع     | توضیح                   |
| ------------ | ------- | ----------------------- |
| id           | string  | شناسه یکتا              |
| name         | string  | نام مشتری               |
| phone        | string? | شماره تماس              |
| email        | string? | ایمیل                   |
| address      | string? | نشانی                   |
| economicCode | string? | کد اقتصادی              |
| nationalId   | string? | شناسه ملی، در صورت نیاز |
| notes        | string? | توضیحات                 |
| createdAt    | string  | زمان ایجاد ISO 8601     |
| updatedAt    | string  | زمان آخرین تغییر        |

ایندکس‌ها: `id`، `name`، `phone`، `updatedAt`

### 2.2. Store: `products`

اطلاعات کالاها و خدمات.

| فیلد         | نوع     | توضیح            |
| ------------ | ------- | ---------------- |
| id           | string  | شناسه یکتا       |
| name         | string  | نام کالا یا خدمت |
| description  | string? | توضیحات          |
| sku          | string? | کد محصول         |
| unit         | string  | واحد شمارش       |
| defaultPrice | number  | قیمت پیش‌فرض     |
| isActive     | boolean | فعال یا غیرفعال  |
| createdAt    | string  | زمان ایجاد       |
| updatedAt    | string  | زمان آخرین تغییر |

ایندکس‌ها: `id`، `name`، `sku`، `isActive`

قیمت‌ها باید به‌صورت عدد صحیح و در کوچک‌ترین واحد پولی مورد استفاده ذخیره شوند؛ واحد پول کل برنامه باید مشخص باشد و تبدیل ریال و تومان نباید به‌صورت ضمنی انجام شود.

### 2.3. Store: `invoices`

موجودیت اصلی فاکتور.

| فیلد             | نوع     | توضیح                            |
| ---------------- | ------- | -------------------------------- |
| id               | string  | شناسه یکتا                       |
| number           | string  | شماره قابل نمایش                 |
| type             | string  | `sale`، `purchase` یا `proforma` |
| status           | string  | وضعیت فاکتور                     |
| customerId       | string? | شناسه مشتری، در صورت وجود        |
| customerSnapshot | object? | اطلاعات مشتری هنگام صدور         |
| issueDate        | string  | تاریخ صدور                       |
| dueDate          | string? | سررسید                           |
| currency         | string  | واحد پول                         |
| subtotal         | number  | جمع پیش از تخفیف و مالیات        |
| discountType     | string  | نوع تخفیف                        |
| discountValue    | number  | مقدار تخفیف                      |
| discountAmount   | number  | مبلغ تخفیف محاسبه‌شده            |
| additionalCosts  | array   | هزینه‌های جانبی                  |
| taxTotal         | number  | جمع مالیات                       |
| total            | number  | مبلغ نهایی                       |
| paidAmount       | number  | مجموع پرداخت‌های ثبت‌شده         |
| notes            | string? | توضیحات                          |
| terms            | string? | شرایط پرداخت                     |
| templateId       | string  | قالب انتخاب‌شده                  |
| createdAt        | string  | زمان ایجاد                       |
| updatedAt        | string  | زمان آخرین تغییر                 |

ایندکس‌ها: `id`، `number`، `type`، `status`، `customerId`، `issueDate`، `createdAt`

مبلغ مانده بهتر است از رابطه `total - paidAmount` محاسبه شود تا مقدار ذخیره‌شده با پرداخت‌ها ناسازگار نشود.

### 2.4. Store: `invoiceItems`

اقلام هر فاکتور به‌صورت رکوردهای مستقل ذخیره می‌شوند.

| فیلد           | نوع     | توضیح                 |
| -------------- | ------- | --------------------- |
| id             | string  | شناسه یکتا            |
| invoiceId      | string  | شناسه فاکتور          |
| productId      | string? | شناسه محصول اصلی      |
| name           | string  | نام ثبت‌شده در فاکتور |
| description    | string? | توضیحات ثبت‌شده       |
| unit           | string  | واحد                  |
| quantity       | number  | تعداد                 |
| unitPrice      | number  | قیمت واحد             |
| discountType   | string  | نوع تخفیف ردیف        |
| discountValue  | number  | مقدار تخفیف           |
| discountAmount | number  | مبلغ تخفیف            |
| taxRate        | number  | نرخ مالیات            |
| taxAmount      | number  | مبلغ مالیات           |
| lineTotal      | number  | مبلغ نهایی ردیف       |
| sortOrder      | number  | ترتیب نمایش           |

ایندکس‌ها: `id`، `invoiceId`، `productId`

نام، واحد و قیمت باید در خود ردیف فاکتور ذخیره شوند تا تغییر اطلاعات محصول، سوابق قبلی را تغییر ندهد.

### 2.5. Store: `payments`

پرداخت‌های ثبت‌شده برای فاکتورها.

| فیلد      | نوع     | توضیح        |
| --------- | ------- | ------------ |
| id        | string  | شناسه یکتا   |
| invoiceId | string  | شناسه فاکتور |
| amount    | number  | مبلغ پرداخت  |
| date      | string  | تاریخ پرداخت |
| method    | string  | روش پرداخت   |
| reference | string? | شماره پیگیری |
| notes     | string? | توضیحات      |
| createdAt | string  | زمان ثبت     |

ایندکس‌ها: `id`، `invoiceId`، `date`

پرداخت‌ها باید در تراکنش ذخیره شوند. پس از ثبت یا حذف پرداخت، مجموع پرداختی فاکتور مجدداً محاسبه شود.

### 2.6. Store: `settings`

تنظیمات برنامه و اطلاعات فروشنده.

| فیلد      | نوع     | توضیح       |
| --------- | ------- | ----------- |
| id        | string  | کلید تنظیم  |
| value     | unknown | مقدار تنظیم |
| updatedAt | string  | زمان تغییر  |

نمونه کلیدها:

* `sellerInfo`
* `defaultCurrency`
* `defaultTaxRate`
* `invoiceNumbering`
* `defaultTemplateId`
* `logo`
* `appearance`
* `onboardingCompleted`

تصاویر لوگو بهتر است به‌صورت Blob یا در یک Store مجزا ذخیره شوند، نه به‌شکل رشته Base64 بزرگ در تنظیمات.

### 2.7. Store: `counters`

مدیریت شماره‌گذاری خودکار.

| فیلد       | نوع    | توضیح        |
| ---------- | ------ | ------------ |
| id         | string | کلید شمارنده |
| prefix     | string | پیشوند شماره |
| nextNumber | number | شماره بعدی   |
| padding    | number | تعداد رقم    |
| updatedAt  | string | آخرین تغییر  |

برای جلوگیری از شماره تکراری، تخصیص شماره باید در تراکنش انجام شود. شماره‌های تخصیص‌یافته و لغوشده نباید بدون سیاست مشخص دوباره استفاده شوند.

### 2.8. Store: `appMeta`

اطلاعات فنی برنامه.

| فیلد  | نوع     | توضیح |
| ----- | ------- | ----- |
| key   | string  | کلید  |
| value | unknown | مقدار |

موارد استفاده:

* نسخه Schema دیتابیس
* زمان آخرین Migration
* نسخه فرمت خروجی
* اطلاعات لازم برای ارتقای برنامه

### 2.9. Store: `licenseState`

وضعیت محلی مجوز Pro؛ این Store مرجع نهایی اعتبار خرید نیست.

| فیلد              | نوع     | توضیح                      |
| ----------------- | ------- | -------------------------- |
| id                | string  | شناسه رکورد                |
| installationId    | string  | شناسه تصادفی نصب           |
| licenseToken      | string? | توکن مجوز، در صورت استفاده |
| status            | string  | وضعیت آخرین تأیید          |
| activatedAt       | string? | زمان فعال‌سازی             |
| lastVerifiedAt    | string? | آخرین اعتبارسنجی           |
| recoveryAvailable | boolean | امکان بازیابی              |

این اطلاعات نباید شامل کلید خصوصی یا راز سمت سرور باشند. پاک‌شدن داده‌های مرورگر ممکن است این رکورد را حذف کند؛ بنابراین مسیر بازیابی مجوز باید مستقل باشد.

---

## 3. روابط بین موجودیت‌ها

```text
Customer
   │
   └── Invoice (اطلاعات مشتری به‌صورت Snapshot)
          │
          ├── InvoiceItem
          │      └── Product (مرجع اختیاری)
          │
          └── Payment

Settings
Counters
AppMeta
LicenseState
```

روابط دیتابیس در IndexedDB به‌صورت خودکار مانند دیتابیس رابطه‌ای اعمال نمی‌شوند؛ بنابراین حذف یا تغییر رکوردهای مرتبط باید با قواعد مشخص و تراکنش مدیریت شود.

## 4. قواعد مهم داده و محاسبات

1. مبالغ پولی به‌صورت عدد صحیح ذخیره شوند؛ از محاسبات مالی با اعداد اعشاری شناور بدون راهکار گردکردن دقیق پرهیز شود.
2. گردکردن مالیات و تخفیف باید در یک سرویس مرکزی و مطابق سیاست تعریف‌شده انجام شود.
3. `subtotal` برابر جمع مبلغ ردیف‌ها پیش از تخفیف کلی و مالیات است.
4. `total` از جمع ردیف‌ها، تخفیف‌ها، هزینه‌های جانبی و مالیات طبق فرمول واحد برنامه محاسبه می‌شود.
5. `paidAmount` از مجموع پرداخت‌های معتبر به دست می‌آید.
6. `remainingAmount = total - paidAmount`.
7. تغییر محصول یا مشتری نباید Snapshot فاکتور صادرشده را تغییر دهد.
8. حذف مشتری نباید فاکتورهای تاریخی را حذف کند.
9. پیش‌فاکتور و فاکتور فروش باید نوع و چرخه وضعیت مشخص داشته باشند.
10. عملیات ذخیره فاکتور و اقلام آن باید اتمیک باشد؛ در صورت شکست، تغییر ناقص باقی نماند.

## 5. قواعد حذف و آرشیو

* مشتری و محصولی که سابقه استفاده دارند، ترجیحاً غیرفعال شوند.
* حذف فاکتور باید با تأیید کاربر انجام شود.
* اگر حذف فاکتور مجاز است، رفتار آن با پرداخت‌های وابسته باید مشخص باشد.
* نسخه اولیه می‌تواند فاکتورهای حذف‌شده را بدون Store جداگانه مدیریت کند؛ اگر بازیابی فاکتور حذف‌شده لازم شد، Soft Delete به‌عنوان قابلیت مجزا اضافه شود.
* پاک‌کردن کامل داده‌ها فقط با اقدام صریح کاربر انجام شود.
* پاک‌کردن داده‌های محلی نباید باعث لغو خودکار خرید Pro شود.

## 6. نسخه‌بندی و Migration

* نسخه Schema دیتابیس باید در کد تعریف شود.
* هر تغییر ساختار نیازمند Migration باشد.
* Migration باید تا حد امکان تراکنشی و قابل آزمون باشد.
* پیش از انتشار نسخه‌ای با تغییرات ناسازگار، فرایند خروجی گرفتن از اطلاعات آزمایش شود.
* نسخه جدید برنامه نباید دیتابیس را بدون دلیل یا هشدار حذف کند.

## 7. مرز Frontend و Backend

### Frontend

* تمام اطلاعات مشتریان، محصولات، فاکتورها و پرداخت‌ها
* محاسبات و گزارش‌های محلی
* خروجی و بازیابی
* رابط کاربری و تولید PDF
* وضعیت آخرین مجوز تأییدشده

### Backend

* سفارش خرید
* تأیید پرداخت
* صدور و اعتبارسنجی مجوز
* بازیابی مجوز و مدیریت فعال‌سازی

اطلاعات فاکتور، مشتری و محصول نباید برای تأیید Pro به Backend ارسال شوند.

## 8. معیار آماده‌بودن دیتابیس

* ایجاد، ویرایش و خواندن هر موجودیت تست شده باشد.
* ارتباط فاکتور، اقلام و پرداخت‌ها درست عمل کند.
* تغییر مشتری و محصول روی فاکتورهای قدیمی اثر نگذارد.
* شماره‌گذاری تکراری رخ ندهد.
* جمع مبالغ و مانده پرداختی با محاسبات مرجع یکسان باشد.
* Migration بدون از دست رفتن اطلاعات آزمایش شود.
* خروجی و بازیابی اطلاعات در یک نصب تازه تست شود.
* پس از قطع اینترنت، اطلاعات قبلی همچنان در دسترس باشند.

---

**وضعیت:** این سند، قرارداد فنی اولیه برای شروع پیاده‌سازی است. قبل از کدنویسی، فرمول دقیق تخفیف و مالیات، واحد پول داخلی، قواعد شماره‌گذاری و سیاست حذف فاکتور باید با PRD تطبیق داده شوند.
