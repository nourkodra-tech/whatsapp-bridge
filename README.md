# WhatsApp Baileys Bridge (v2 - Multi-Company & Crash-Resistant)

سيرفر الواتساب الخارجي المعدل لتطبيق التسويق:
- متوافق مع Node 20 LTS على Railway / Docker لمنع خطأ Crash 500.
- حماية ضد انهيار السيرفر (Anti-Crash process handlers).
- دعم إرسال البوستات لمجموعات الواتساب (`@g.us`).
- دعم قنوات الواتساب (`@newsletter`).
- دعم النشر على حالة الواتساب (WhatsApp Status / الستوري) مع منشن الجروب.
- دعم التحقق الآمن بـ `BRIDGE_TOKEN`.

## متغيرات البيئة المطلوبة في Railway (Variables):
1. `PORT` = `3000`
2. `BRIDGE_TOKEN` = `كلمتك_السرية_هنا`
3. `NIXPACKS_NODE_VERSION` = `20` (اختياري، محدد تلقائياً في nixpacks.toml)
