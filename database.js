/* Versioned, offline-first IndexedDB repositories. Business records stay on this device. */
(() => {
  const NAME = 'InvoiceMakerDB';
  const VERSION = 2;
  const definitions = {
    customers: ['id','name','phone','email','updatedAt'],
    products: ['id','name','sku','isActive'],
    invoices: ['id','number','type','status','customerId','issueDate','createdAt'],
    invoiceItems: ['id','invoiceId','productId'],
    payments: ['id','invoiceId','date'],
    settings: ['id'], counters: ['id'], appMeta: ['key'], licenseState: ['id']
  };
  const keyPath = name => name === 'appMeta' ? 'key' : 'id';
  let opening;
  const uuid = () => crypto.randomUUID();

  function open() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('مرورگر شما ذخیره‌سازی محلی را پشتیبانی نمی‌کند.'));
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const [name, fields] of Object.entries(definitions)) {
          const store = db.objectStoreNames.contains(name)
            ? req.transaction.objectStore(name)
            : db.createObjectStore(name, { keyPath: keyPath(name) });
          for (const field of fields.slice(1)) if (!store.indexNames.contains(field)) store.createIndex(field, field, { unique: false });
        }
      };
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error || new Error('بازکردن پایگاه داده ناموفق بود.'));
      req.onblocked = () => reject(new Error('به‌روزرسانی پایگاه داده در برگه دیگری مسدود شده است.'));
    });
    return opening;
  }
  function transaction(names, mode, work) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      let value;
      try { value = work(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('ذخیره‌سازی اطلاعات ناموفق بود.'));
    }));
  }
  const req = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const getAll = (store, index, value) => index ? req(store.index(index).getAll(value)) : req(store.getAll());

  const DB = {
    version: VERSION,
    ready: open,
    all: name => open().then(db => req(db.transaction(name).objectStore(name).getAll())),
    byIndex: (name, index, value) => open().then(db => req(db.transaction(name).objectStore(name).index(index).getAll(value))),
    get: (name, id) => open().then(db => req(db.transaction(name).objectStore(name).get(id))),
    put: (name, record) => transaction([name], 'readwrite', tx => tx.objectStore(name).put(record)),
    putMany: (name, records) => transaction([name], 'readwrite', tx => records.forEach(row => tx.objectStore(name).put(row))),
    remove: (name, id) => transaction([name], 'readwrite', tx => tx.objectStore(name).delete(id)),
    setting: async (id, fallback = null) => (await DB.get('settings', id))?.value ?? fallback,
    saveSetting: (id, value) => DB.put('settings', { id, value, updatedAt: new Date().toISOString() }),
    nextInvoiceNumber: async (prefix = 'INV-', padding = 5) => transaction(['counters','invoices'], 'readwrite', tx => {
      const store = tx.objectStore('counters');
      const result = new Promise((resolve, reject) => {
        const get = store.get('invoice');
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          const counter = get.result || { id: 'invoice', prefix, nextNumber: 1, padding };
          const choose = () => {
            const number = `${prefix}${String(counter.nextNumber).padStart(padding, '0')}`;
            tx.objectStore('invoices').index('number').get(number).onsuccess = event => {
              counter.nextNumber += 1;
              if (event.target.result) return choose();
              counter.prefix = prefix; counter.padding = padding; counter.updatedAt = new Date().toISOString();
              store.put(counter); resolve(number);
            };
          };
          choose();
        };
      });
      return result;
    }),
    saveInvoice: (invoice, items) => transaction(['invoices','invoiceItems'], 'readwrite', tx => {
      const invoices = tx.objectStore('invoices'), rows = tx.objectStore('invoiceItems');
      const oldItems = rows.index('invoiceId').openCursor(IDBKeyRange.only(invoice.id));
      oldItems.onsuccess = () => {
        const cursor = oldItems.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
        else { invoices.put(invoice); items.forEach(item => rows.put({ ...item, id: item.id || uuid(), invoiceId: invoice.id })); }
      };
    }),
    invoiceBundle: id => open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(['invoices','invoiceItems','payments']);
      const invoice = tx.objectStore('invoices').get(id), items = tx.objectStore('invoiceItems').index('invoiceId').getAll(id), payments = tx.objectStore('payments').index('invoiceId').getAll(id);
      tx.oncomplete = () => resolve({ invoice: invoice.result, items: items.result, payments: payments.result }); tx.onerror = () => reject(tx.error);
    })),
    addPayment: (payment, invoiceId) => transaction(['payments','invoices'], 'readwrite', tx => {
      const invoiceStore = tx.objectStore('invoices'), paymentStore = tx.objectStore('payments');
      paymentStore.add({ ...payment, id: payment.id || uuid(), invoiceId });
      const get = invoiceStore.get(invoiceId);
      get.onsuccess = () => {
        const invoice = get.result; if (!invoice) { tx.abort(); return; }
        const sumReq = paymentStore.index('invoiceId').getAll(invoiceId);
        sumReq.onsuccess = () => {
          invoice.paidAmount = sumReq.result.reduce((sum, row) => sum + row.amount, 0);
          invoice.status = invoice.paidAmount >= invoice.total ? 'paid' : invoice.paidAmount ? 'partial' : invoice.status;
          invoice.updatedAt = new Date().toISOString(); invoiceStore.put(invoice);
        };
      };
    }),
    deletePayment: (id, invoiceId) => transaction(['payments','invoices'], 'readwrite', tx => {
      const paymentStore=tx.objectStore('payments'),invoiceStore=tx.objectStore('invoices');paymentStore.delete(id);
      const invoiceReq=invoiceStore.get(invoiceId);invoiceReq.onsuccess=()=>{const invoice=invoiceReq.result;if(!invoice){tx.abort();return;}const all=paymentStore.index('invoiceId').getAll(invoiceId);all.onsuccess=()=>{invoice.paidAmount=all.result.reduce((sum,row)=>sum+row.amount,0);invoice.status=invoice.paidAmount>=invoice.total?'paid':invoice.paidAmount?'partial':invoice.status==='paid'?'sent':invoice.status;invoice.updatedAt=new Date().toISOString();invoiceStore.put(invoice);};};
    }),
    deleteInvoice: id => transaction(['invoices','invoiceItems','payments'], 'readwrite', tx => {
      tx.objectStore('invoices').delete(id);
      for (const name of ['invoiceItems','payments']) {
        const cursor = tx.objectStore(name).index('invoiceId').openCursor(IDBKeyRange.only(id));
        cursor.onsuccess = () => { const row = cursor.result; if (row) { row.delete(); row.continue(); } };
      }
    }),
    replace: records => transaction(Object.keys(records), 'readwrite', tx => {
      for (const [name, rows] of Object.entries(records)) { const store = tx.objectStore(name); store.clear(); rows.forEach(row => store.put(row)); }
    }),
    clearBusinessData: () => transaction(['customers','products','invoices','invoiceItems','payments'], 'readwrite', tx => {
      for (const name of ['customers','products','invoices','invoiceItems','payments']) tx.objectStore(name).clear();
    }),
    backup: async () => {
      const names = Object.keys(definitions), values = await Promise.all(names.map(name => DB.all(name)));
      return Object.fromEntries(names.map((name, i) => [name, values[i]]));
    },
    importBackup: (records, mode) => open().then(async db => {
      const names = Object.keys(definitions);
      const incoming = Object.fromEntries(names.map(name => [name, Array.isArray(records[name]) ? records[name] : []]));
      // A business-data restore must never erase a locally activated Pro license.
      incoming.licenseState = await req(db.transaction('licenseState').objectStore('licenseState').getAll());
      let target = incoming;
      if (mode === 'merge') {
        const current = await Promise.all(names.map(name => req(db.transaction(name).objectStore(name).getAll())));
        target = Object.fromEntries(names.map((name, i) => {
          const byId = new Map(current[i].map(row => [row[keyPath(name)], row]));
          for (const row of incoming[name]) if (!byId.has(row[keyPath(name)])) byId.set(row[keyPath(name)], row);
          return [name, [...byId.values()]];
        }));
      }
      return DB.replace(target);
    })
  };
  window.FactorinoDB = DB;
})();
