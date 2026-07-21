# Manual del Operador — Bot WhatsApp Clínica

Guía práctica para el personal de operaciones (no desarrolladores) que mantiene el bot en producción.
Complementa la documentación técnica del `README.md`.

> **Convenciones**
> - `$BOT_HOST` — dominio o IP donde corre el bot (por defecto `http://localhost:3000`).
> - `$API_TOKEN` — valor de `API_SECRET_TOKEN` definido en `.env`. Nunca compartirlo en canales públicos.
> - Todos los comandos se ejecutan desde el directorio raíz del proyecto salvo indicación contraria.

---

## 1. Levantar el bot en producción

### Requisitos previos
- Node.js 24+ instalado (`node --version`).
- `.env` correctamente poblado (ver `.env.example`).
- Carpeta `data/` con permisos de escritura (SQLite).
- Carpeta `auth/` con permisos de escritura (credenciales Baileys).

### Opción A — PM2 (recomendado en VPS)

Instalar PM2 la primera vez:

```bash
npm install -g pm2
```

Arrancar / reiniciar el bot:

```bash
cd /ruta/al/proyecto
npm install --production
pm2 start src/index.js --name bot-clinica --time
pm2 save
pm2 startup    # genera script de arranque automático
```

Operaciones comunes:

```bash
pm2 status                 # ver si está corriendo
pm2 logs bot-clinica       # seguir logs en vivo (Ctrl+C para salir)
pm2 logs bot-clinica --err # solo errores
pm2 restart bot-clinica    # reiniciar
pm2 stop bot-clinica       # detener
```

### Opción B — systemd (Linux)

Crear `/etc/systemd/system/bot-clinica.service`:

```ini
[Unit]
Description=Bot WhatsApp Clinica
After=network.target

[Service]
Type=simple
User=botuser
WorkingDirectory=/ruta/al/proyecto
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/var/log/bot-clinica.log
StandardError=append:/var/log/bot-clinica.err

[Install]
WantedBy=multi-user.target
```

Activar y operar:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bot-clinica
sudo systemctl start bot-clinica
sudo systemctl status bot-clinica
sudo journalctl -u bot-clinica -f
```

### Verificar que arrancó bien

```bash
curl http://localhost:3000/health
```

Respuesta esperada:

```json
{"status":"ok","whatsapp":"connected","timestamp":"..."}
```

Si `whatsapp` dice `disconnected`, revisa el siguiente paso (QR).

---

## 2. Escanear el QR la primera vez

La primera vez que el bot arranca (o cuando se pierde la sesión), WhatsApp exige vincular el número escaneando un código QR.

### Opción A — QR en terminal
Si corre en primer plano, el QR aparece impreso en la consola como texto.
En PM2: `pm2 logs bot-clinica` y busca el bloque ASCII del QR.

### Opción B — QR vía HTTP
Cuando está como servicio, es más cómodo verlo desde un navegador:

```
http://$BOT_HOST:3000/qr
```

Si el bot ya está vinculado, la ruta `/qr` devuelve el mensaje `WhatsApp ya está conectado`.

### Procedimiento de vinculación

1. En el teléfono, abre **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo**.
2. Escanea el QR que muestra la terminal o `/qr`.
3. Espera la confirmación en el log: `WhatsApp conectado correctamente`.
4. Verifica con `curl $BOT_HOST/health` que `whatsapp` = `connected`.

### Cuándo hay que reescanear
- La carpeta `auth/` se borró o se corrompió.
- El teléfono cerró sesión manualmente desde *Dispositivos vinculados*.
- Se migró a otro servidor sin copiar `auth/`.

> ⚠️ **No borres `auth/` en caliente**. Detén primero el bot, borra la carpeta y vuelve a arrancar.

---

## 3. Enviar broadcasts segmentados

Endpoint: `POST /broadcast` (requiere Bearer token).

### Segmentos disponibles
- `todos_activos` — pacientes sin baja ARCO.
- `cumpleaneros_mes` — cumplen años este mes.
- `inactivos_90d` — sin cita en los últimos 90 días.
- `asistio_reciente` — asistieron a consulta en los últimos 30 días.

### Placeholders
- `{{nombre}}` — primer nombre del paciente.

### Ejemplo (cumpleañeros del mes)

```bash
curl -X POST $BOT_HOST/broadcast \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "segmento": "cumpleaneros_mes",
    "mensaje": "¡Feliz cumpleaños {{nombre}}! 🎉 Te regalamos 20% en tu próxima consulta."
  }'
```

### Ejemplo (reactivar inactivos)

```bash
curl -X POST $BOT_HOST/broadcast \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "segmento": "inactivos_90d",
    "mensaje": "Hola {{nombre}}, hace tiempo no te vemos. ¿Agendamos revisión?"
  }'
```

### Respuesta

```json
{ "segmento": "cumpleaneros_mes", "total": 37, "enviados": 37, "fallos": 0 }
```

### Salvaguardas
- El servicio limita a **1 mensaje por segundo** para no disparar bans.
- Si el segmento tiene más de **500 destinatarios**, el endpoint responde `400` salvo que se añada `"force": true`.
- Pacientes con `baja_fecha` (ARCO) nunca reciben broadcasts.
- Cada envío se registra como evento `broadcast_enviado` en `metricas_eventos`.

---

## 4. Consultar NPS de la semana

La tabla `nps_respuestas` se alimenta del job diario 19:00. Para consultar desde cualquier cliente SQLite:

```bash
sqlite3 data/clinic.db
```

### Resumen rápido (últimos 7 días)

```sql
SELECT
  COUNT(*)                                                   AS total,
  SUM(CASE WHEN puntaje BETWEEN 9 AND 10 THEN 1 ELSE 0 END) AS promotores,
  SUM(CASE WHEN puntaje BETWEEN 7 AND 8  THEN 1 ELSE 0 END) AS pasivos,
  SUM(CASE WHEN puntaje <= 6             THEN 1 ELSE 0 END) AS detractores,
  ROUND(AVG(puntaje), 2)                                     AS promedio
FROM nps_respuestas
WHERE respondido_en >= datetime('now','localtime','-7 days');
```

### Cálculo del NPS (escala -100 a 100)

```sql
SELECT
  ROUND(
    (100.0 * SUM(CASE WHEN puntaje BETWEEN 9 AND 10 THEN 1 ELSE 0 END)
    - 100.0 * SUM(CASE WHEN puntaje <= 6 THEN 1 ELSE 0 END))
    / NULLIF(COUNT(puntaje), 0), 2) AS nps_score
FROM nps_respuestas
WHERE respondido_en >= datetime('now','localtime','-7 days');
```

### Detractores con comentario (para follow-up)

```sql
SELECT n.respondido_en, n.telefono, p.nombre, n.puntaje, n.comentario
FROM nps_respuestas n
LEFT JOIN pacientes p ON p.telefono = n.telefono
WHERE n.puntaje <= 6
  AND n.comentario IS NOT NULL
  AND n.respondido_en >= datetime('now','localtime','-7 days')
ORDER BY n.respondido_en DESC;
```

---

## 5. Agregar un médico nuevo

No hay panel admin aún; el alta se hace con SQL directo.

```bash
sqlite3 data/clinic.db
```

```sql
INSERT INTO medicos (
  nombre, especialidad, telefono,
  horario_inicio, horario_fin,
  dias_laborales, duracion_cita_min, activo
) VALUES (
  'Dra. Pérez', 'Pediatría', '5215555555555',
  '09:00', '18:00',
  'lun,mar,mie,jue,vie', 30, 1
);
```

### Campos clave
- `dias_laborales`: CSV con abreviaturas en español (`lun,mar,mie,jue,vie,sab,dom`).
- `horario_inicio` / `horario_fin`: formato `HH:MM` 24 h.
- `duracion_cita_min`: duración estándar (30 ó 60 son los valores típicos).
- `activo = 0` lo oculta del flujo de agendamiento sin borrarlo.

### Dar de baja (sin perder historial)

```sql
UPDATE medicos SET activo = 0 WHERE id = 2;
```

### Verificar que el bot lo ve

```sql
SELECT id, nombre, especialidad, activo FROM medicos;
```

Reinicia el bot para que refresque cachés: `pm2 restart bot-clinica`.

---

## 6. Investigar un problema reportado por un paciente

Cuando un paciente dice *"no me contestó"*, *"se perdió mi cita"* o *"me cobró mal"*, revisa `metricas_eventos` en orden de prioridad:

### 6.1 Ver toda la actividad reciente de un teléfono

```sql
SELECT creado_en, tipo, payload
FROM metricas_eventos
WHERE telefono = '5215551234567'
ORDER BY id DESC
LIMIT 50;
```

### 6.2 Tipos de eventos relevantes

| Tipo                      | Significa                                              |
|---------------------------|--------------------------------------------------------|
| `intent_detectado`        | El parser reconoció la intención (agendar, cancelar…). |
| `fallback_groq`           | El parser no reconoció → se delegó a LLM.              |
| `cita_creada`             | Cita insertada en BD.                                  |
| `cita_cancelada`          | Cita cancelada.                                        |
| `cita_reagendada`         | Cita movida a otra fecha/hora.                         |
| `escalacion`              | El bot pidió intervención humana.                      |
| `triage_urgencia_alta`    | Mensaje con señales de urgencia médica.                |
| `broadcast_enviado`       | Paciente recibió un broadcast.                         |

### 6.3 Últimas escalaciones (requieren atención humana)

```sql
SELECT creado_en, telefono, payload
FROM metricas_eventos
WHERE tipo = 'escalacion'
ORDER BY id DESC LIMIT 20;
```

### 6.4 Últimas urgencias (revisar primero)

```sql
SELECT creado_en, telefono, payload
FROM metricas_eventos
WHERE tipo = 'triage_urgencia_alta'
ORDER BY id DESC LIMIT 20;
```

### 6.5 Atajo: panel web

Abrir en el navegador:

```
http://$BOT_HOST:3000/panel.html?token=$API_TOKEN
```

Muestra KPIs de 7 días, gráficas de intents/fallbacks y citas de 30 días, últimas escalaciones y últimas urgencias. Equivalente visual a las queries anteriores.

### 6.6 Exportar datos completos del paciente (soporte legal)

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  $BOT_HOST/arco/5215551234567
```

Devuelve JSON con perfil, citas activas e historial completo.

---

## 7. Procedimiento de baja de datos (ARCO / LFPDPPP)

Resumen operativo:

### 7.1 Flujo automático (el paciente escribe al bot)

Si el paciente envía *"quiero darme de baja"*, *"eliminar mis datos"*, *"ejerzo mis derechos ARCO"*, el bot:
1. Marca `pacientes.baja_fecha = datetime('now','localtime')`.
2. Cancela todas sus citas activas.
3. Elimina eventos de Google Calendar.
4. Deja de enviarle broadcasts y NPS.
5. Registra evento `baja_arco` en `metricas_eventos`.

### 7.2 Flujo manual (solicitud por correo, teléfono o presencial)

**Paso 1 — Verificar identidad del solicitante.** Pide INE o llamada al número registrado. No procedas sin verificar.

**Paso 2 — Ejecutar baja por endpoint:**

```bash
curl -X DELETE \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"motivo":"Solicitud ARCO por correo 2026-04-22"}' \
  $BOT_HOST/arco/5215551234567
```

Respuesta:

```json
{ "success": true, "citas_canceladas": 2 }
```

**Paso 3 — Exportar datos antes de borrar (si el paciente los pidió):**

```bash
curl -H "Authorization: Bearer $API_TOKEN" \
  $BOT_HOST/arco/5215551234567 > respaldo-ARCO-5215551234567.json
```

**Paso 4 — Registrar la solicitud** en el expediente físico/digital de la clínica con: fecha, motivo, quién solicitó, evidencia de identidad.

**Paso 5 — Responder al titular** en los plazos que marca la LFPDPPP (20 días hábiles para responder, 15 adicionales para ejecutar si es baja).

### 7.3 Qué NO se borra

- Eventos en `metricas_eventos` ya anonimizados (sin PII bruta) — se retienen por fines estadísticos.
- Citas en historial se conservan con referencia al `paciente_id` pero el paciente queda como `baja_fecha` poblado.
- Cumplimiento de obligaciones fiscales (facturas): los datos requeridos por SAT se conservan según plazos legales.

### 7.4 Verificar que la baja se aplicó

```sql
SELECT telefono, nombre, baja_fecha, baja_motivo
FROM pacientes WHERE telefono = '5215551234567';
```

`baja_fecha` debe tener timestamp. Si sigue en `NULL`, reintenta el `DELETE /arco/:telefono`.

---

## Apéndice A — Endpoints del bot (cheat-sheet)

| Método | Ruta                                | Auth            | Para qué                                     |
|--------|--------------------------------------|-----------------|----------------------------------------------|
| GET    | `/health`                            | —               | Healthcheck + estado de WhatsApp             |
| GET    | `/qr`                                | —               | QR para vincular WhatsApp                    |
| GET    | `/aviso-privacidad`                  | —               | Aviso de privacidad público (HTML)           |
| POST   | `/send-message`                      | Bearer          | Enviar mensaje puntual a un teléfono         |
| POST   | `/broadcast`                         | Bearer          | Envío segmentado                      |
| GET    | `/panel`                             | Bearer          | KPIs 7 días (JSON)                           |
| GET    | `/panel.html?token=…`                | query-token     | Panel web con gráficas                |
| GET    | `/api/panel/series?dias=30`          | Bearer o token  | Series diarias para gráficas                 |
| GET    | `/arco/:telefono`                    | Bearer          | Exportar datos del paciente (ARCO)           |
| DELETE | `/arco/:telefono`                    | Bearer          | Dar de baja datos del paciente (ARCO)        |
| POST   | `/stripe-webhook`                    | firma Stripe    | Webhook de pagos (, no invocar manual)   |

---

## Apéndice B — Archivos y carpetas importantes

| Ruta                   | Contenido                                                 |
|------------------------|-----------------------------------------------------------|
| `.env`                 | Secretos y configuración. **NO subir a git.**             |
| `data/clinic.db`       | Base de datos SQLite. Respaldar diariamente.              |
| `auth/`                | Credenciales de WhatsApp. Respaldar, no versionar.        |
| `logs/app.log`         | Log operativo (info + warn).                              |
| `logs/error.log`       | Solo errores. Revisar si el bot se porta raro.            |
| `public/panel.html`    | Panel web estático.                                |

## Apéndice C — Respaldo diario sugerido

Crontab del servidor:

```cron
0 2 * * * cd /ruta/al/proyecto && tar czf /backup/clinic-$(date +\%F).tgz data auth .env
```

Mantén al menos 14 días de respaldos rotados. Probar restauración cada trimestre.
