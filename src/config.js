export const BRAND = 'IKU';

export const INNER_PACK_SIZE = 12;
export const MASTER_BAG_SIZE = 10;
export const MASTER_BAG_TOTAL = INNER_PACK_SIZE * MASTER_BAG_SIZE;

export const REPORTS = {
  MO: 'All_MO',
  LOG: 'Production_Log_Report',
  INNER_PACK: 'All_Inner_Pack',
  MASTER_BAG: 'All_Master_Bag',
};

export const FORMS = {
  LOG: 'Add_Production_Log',
  INNER_PACK: 'Add_Inner_Pack',
  MASTER_BAG: 'Add_Master_Bag',
};

export const QR_PREFIX = {
  INNER: `${BRAND}-INNER-`,
  BAG: `${BRAND}-BAG-`,
};

export const PACK_STATUS_LABELS = {
  'Created':          '已创建 / Created',
  'Bagged':           '已装袋 / Bagged',
  'Shipped':          '已发货 / Shipped',
  'Received':         '已入仓 / Received',
  'Out_For_Delivery': '配送中 / Out for Delivery',
  'Delivered':        '已交付 / Delivered',
};

export const BAG_STATUS_LABELS = {
  'Created':          '已创建 / Created',
  'Shipped':          '已发货 / Shipped',
  'Received':         '已入仓 / Received',
  'Out_For_Delivery': '配送中 / Out for Delivery',
  'Delivered':        '已交付 / Delivered',
};

export const APP_PIN = 'jera8888';
export const PIN_STORAGE_KEY = 'factoryapp_pin_verified';
