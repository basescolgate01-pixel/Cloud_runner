"""
GeoVictoria - Actividades del DIA DE HOY
Google Cloud Function - Envía CSV por email automáticamente

Dependencias (requirements.txt):
    requests
    requests-oauthlib
"""

import sys
sys.stdout.reconfigure(encoding='utf-8')

import requests
from requests_oauthlib import OAuth1
import csv, os, io, base64
from datetime import datetime, date, timezone, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

# Zona horaria de Chile (UTC-4 en invierno, UTC-3 en verano)
CHILE_TZ = timezone(timedelta(hours=-4))

# ============================================================
# GEOVICTORIA
CONSUMER_KEY    = "4b79f6"
CONSUMER_SECRET = "0f1761f7"
URL_LOGIN       = "https://apiv3.geovictoria.com/api/v1/Login"
URL_USERS       = "https://customerapi.geovictoria.com/api/v1/User/List"
URL_ACTIVITIES  = "https://apiv3.geovictoria.com/api/Activity/GetActivities"
URL_PROJECTS    = "https://apiv3.geovictoria.com/api/Project/List"
TAM_LOTE        = 150

# EMAIL (Gmail API via OAuth2 — variables de entorno en Railway)
EMAIL_REMITENTE    = os.environ.get("GMAIL_USER", "notificaciones.colgate@gmail.com")
EMAIL_DESTINATARIO = os.environ.get("EMAIL_DESTINO", "mriquelme@ecrgroup.cl")
GMAIL_CLIENT_ID     = os.environ.get("GMAIL_CLIENT_ID", "")
GMAIL_CLIENT_SECRET = os.environ.get("GMAIL_CLIENT_SECRET", "")
GMAIL_REFRESH_TOKEN = os.environ.get("GMAIL_REFRESH_TOKEN", "")
# ============================================================

HOY         = datetime.now(CHILE_TZ).date()
FECHA_DESDE = HOY.strftime("%Y%m%d") + "000000"
FECHA_HASTA = HOY.strftime("%Y%m%d") + "235959"


# ─────────────────────────────────────────────
# GEOVICTORIA
# ─────────────────────────────────────────────

def obtener_token():
    r = requests.post(URL_LOGIN,
        json={"User": CONSUMER_KEY, "Password": CONSUMER_SECRET},
        headers={"Content-Type": "application/json"})
    r.raise_for_status()
    return r.json()["token"]


def obtener_usuarios_activos(token):
    r = requests.post(URL_USERS, json={},
        headers={"Content-Type": "application/json", "Authorization": token})
    r.raise_for_status()
    usuarios = r.json()
    return [str(u["Identifier"]) for u in usuarios
            if str(u.get("Enabled", "0")) == "1"
            and u.get("Identifier") not in (None, "")]


def obtener_proyectos(oauth, token):
    proyectos, tareas = {}, {}
    for url in [URL_PROJECTS, "https://customerapi.geovictoria.com/api/v1/Project/List"]:
        for kw in [{"auth": oauth}, {"headers": {"Content-Type": "application/json", "Authorization": token}}]:
            try:
                base = {"json": {}, "headers": {"Content-Type": "application/json"}, "timeout": 30}
                base.update(kw)
                r = requests.post(url, **base)
                if r.status_code == 200:
                    lista = r.json()
                    if isinstance(lista, dict):
                        lista = lista.get("data", lista.get("Data", []))
                    for p in lista:
                        pid  = p.get("ProjectHashedId") or p.get("Id") or ""
                        desc = p.get("ProjectDescription") or p.get("Description") or ""
                        if pid:
                            proyectos[pid] = desc
                        for t in p.get("Tasks", p.get("tasks", [])):
                            tid   = t.get("TaskHashedId") or t.get("Id") or ""
                            tdesc = t.get("TaskDescription") or t.get("Description") or ""
                            if tid:
                                tareas[tid] = tdesc
                    return proyectos, tareas
            except Exception:
                continue
    return proyectos, tareas


def consultar_lote(oauth, ruts_str):
    body = {"Range": ruts_str, "from": FECHA_DESDE, "to": FECHA_HASTA, "includeAll": "0"}
    r = requests.post(URL_ACTIVITIES, json=body, auth=oauth,
        headers={"Content-Type": "application/json"}, timeout=120)
    if r.status_code == 200:
        data = r.json()
        return data if isinstance(data, list) else []
    print(f"  Error {r.status_code}: {r.text[:200]}")
    return []


def parsear_fecha(s):
    if not s or len(s) < 8:
        return ""
    try:
        return datetime.strptime(s[:14].ljust(14, "0"), "%Y%m%d%H%M%S").strftime("%d/%m/%Y %H:%M")
    except:
        return s


# ─────────────────────────────────────────────
# GENERAR CSV EN MEMORIA (sin guardar en disco)
# ─────────────────────────────────────────────

def generar_csv_en_memoria(actividades, proyectos_dict, tareas_dict):
    campos = [
        "RUT", "Nombre",
        "Proyecto", "Tarea",
        "FechaInicio", "FechaTermino",
        "HorasTrabajadas", "HorasNumero",
        "OrigenEntrada", "OrigenSalida",
        "EntradaModificada", "SalidaModificada",
        "Comentario", "ActividadHabilitada",
        "IdActividad", "IdProyecto", "IdTarea",
        "LatInicio", "LonInicio", "LatTermino", "LonTermino"
    ]

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=campos, extrasaction="ignore")
    writer.writeheader()

    for act in actividades:
        id_proy   = act.get("IdProject", "") or ""
        id_task   = act.get("IdTask", "") or ""
        desc_proy = act.get("ProjectDescription") or proyectos_dict.get(id_proy) or id_proy or "Sin proyecto"
        desc_task = act.get("TaskDescription") or tareas_dict.get(id_task) or id_task or ""
        horas_str = act.get("WorkedHours", "") or ""
        horas_num = ""
        if horas_str:
            try:
                p = horas_str.replace(",", ".").split(":")
                horas_num = round(float(p[0]) + float(p[1]) / 60, 2) if len(p) >= 2 else float(horas_str)
            except:
                pass
        writer.writerow({
            "RUT":               act.get("Identifier", ""),
            "Nombre":            act.get("UserName", ""),
            "Proyecto":          desc_proy,
            "Tarea":             desc_task,
            "FechaInicio":       parsear_fecha(act.get("StartDate", "")),
            "FechaTermino":      parsear_fecha(act.get("EndDate", "")),
            "HorasTrabajadas":   horas_str,
            "HorasNumero":       horas_num,
            "OrigenEntrada":     act.get("OriginStartPunch", ""),
            "OrigenSalida":      act.get("OriginEndPunch", ""),
            "EntradaModificada": act.get("StartDateIsModified", ""),
            "SalidaModificada":  act.get("EndDateIsModified", ""),
            "Comentario":        act.get("Commentary", "") or "",
            "ActividadHabilitada": act.get("ActivityEnabled", ""),
            "IdActividad":       act.get("IdActivity", ""),
            "IdProyecto":        id_proy,
            "IdTarea":           id_task,
            "LatInicio":         act.get("StartPunchGPSLatitude", ""),
            "LonInicio":         act.get("StartPunchGPSLongitude", ""),
            "LatTermino":        act.get("EndPunchGPSLatitude", ""),
            "LonTermino":        act.get("EndPunchGPSLongitude", ""),
        })

    return output.getvalue().encode("utf-8-sig")


# ─────────────────────────────────────────────
# ENVIAR EMAIL CON CSV ADJUNTO
# ─────────────────────────────────────────────

def enviar_email(csv_bytes, n_actividades):
    ahora_chile = datetime.now(CHILE_TZ)
    fecha_str   = ahora_chile.strftime("%d/%m/%Y")
    hora_str    = ahora_chile.strftime("%H:%M")
    nombre_archivo = f"actividades_geovictoria_{ahora_chile.strftime('%Y%m%d_%H%M')}.csv"

    msg = MIMEMultipart()
    msg["From"]    = EMAIL_REMITENTE
    msg["To"]      = EMAIL_DESTINATARIO
    msg["Subject"] = f"✅ GeoVictoria - Actividades {fecha_str} ({hora_str} hrs)"

    cuerpo = f"""
Hola Marceloco,

Se adjunta el CSV con las actividades de GeoVictoria del día {fecha_str}.

📊 Resumen:
   • Total actividades: {n_actividades}
   • Fecha: {fecha_str}
   • Hora de extracción: {hora_str} hrs
   • Archivo: {nombre_archivo}

Este correo fue generado automáticamente.
    """
    msg.attach(MIMEText(cuerpo, "plain"))

    # Adjuntar CSV
    adjunto = MIMEBase("application", "octet-stream")
    adjunto.set_payload(csv_bytes)
    encoders.encode_base64(adjunto)
    adjunto.add_header("Content-Disposition", f"attachment; filename={nombre_archivo}")
    msg.attach(adjunto)

    # Obtener access token via OAuth2 refresh token
    token_resp = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id":     GMAIL_CLIENT_ID,
        "client_secret": GMAIL_CLIENT_SECRET,
        "refresh_token": GMAIL_REFRESH_TOKEN,
        "grant_type":    "refresh_token",
    })
    token_resp.raise_for_status()
    access_token = token_resp.json()["access_token"]

    # Enviar via Gmail API
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    gmail_resp = requests.post(
        f"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"raw": raw},
    )
    gmail_resp.raise_for_status()
    print(f"  ✓ Email enviado a {EMAIL_DESTINATARIO}")


# ─────────────────────────────────────────────
# ENTRY POINT PARA GOOGLE CLOUD FUNCTIONS
# ─────────────────────────────────────────────

def geovictoria_sync(request):
    """Entry point para Google Cloud Functions (HTTP trigger)"""
    try:
        resultado = main()
        return {"status": "ok", "actividades": resultado}, 200
    except Exception as e:
        print(f"ERROR: {e}")
        return {"status": "error", "mensaje": str(e)}, 500


def main():
    ahora_chile = datetime.now(CHILE_TZ)
    print("=" * 60)
    print(f"GeoVictoria - Actividades de HOY ({ahora_chile.strftime('%d/%m/%Y')})")
    print("=" * 60)

    print("\n[1/4] Token...", end=" ")
    token = obtener_token()
    print("✓")

    oauth = OAuth1(CONSUMER_KEY, CONSUMER_SECRET,
                   resource_owner_key="", resource_owner_secret="",
                   signature_method="HMAC-SHA1")

    print("[2/4] Catálogo de proyectos...", end=" ")
    proyectos_dict, tareas_dict = obtener_proyectos(oauth, token)
    print(f"✓  ({len(proyectos_dict)} proyectos)")

    print("[3/4] Usuarios activos...", end=" ")
    ruts_lista = obtener_usuarios_activos(token)
    print(f"✓  ({len(ruts_lista)} activos)")

    n_lotes = -(-len(ruts_lista) // TAM_LOTE)
    print(f"[4/4] Consultando {n_lotes} lote(s)...")
    todas  = []
    oauth2 = OAuth1(CONSUMER_KEY, CONSUMER_SECRET,
                    resource_owner_key="", resource_owner_secret="",
                    signature_method="HMAC-SHA1")
    for i in range(0, len(ruts_lista), TAM_LOTE):
        lote = ruts_lista[i:i + TAM_LOTE]
        num  = i // TAM_LOTE + 1
        print(f"  Lote {num}/{n_lotes} ({len(lote)} usuarios)...", end=" ", flush=True)
        res = consultar_lote(oauth2, ",".join(lote))
        todas.extend(res)
        print(f"→ {len(res)} actividades  (total: {len(todas)})")

    print(f"\n{'='*60}")

    if not todas:
        print("  Sin actividades para hoy.")
        return 0

    print(f"  Generando CSV ({len(todas)} actividades)...", end=" ")
    csv_bytes = generar_csv_en_memoria(todas, proyectos_dict, tareas_dict)
    print("✓")

    print(f"  Enviando email a {EMAIL_DESTINATARIO}...", end=" ")
    enviar_email(csv_bytes, len(todas))

    print(f"{'='*60}")
    return len(todas)


if __name__ == "__main__":
    main()