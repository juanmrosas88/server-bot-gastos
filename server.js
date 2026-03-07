import express from "express";
import twilio from "twilio";
import { google } from "googleapis";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SHEET_ID = process.env.SHEET_ID;
const TZ = { timeZone: "America/Argentina/Buenos_Aires" };

function fechaHoy() {
  return new Date().toLocaleDateString("es-AR", TZ); // dd/mm/aaaa
}

function parsearMensaje(texto) {
  const lineas = texto.trim().split("\n").map(l => l.trim()).filter(l => l.length > 0);
  
  let fecha = null;
  const gastos = [];

  for (const linea of lineas) {
    // Detectar si la línea es solo una fecha: 2/3 o 02/03 o 2/3/2026
    const esFecha = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.test(linea);
    if (esFecha) {
      const match = linea.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      const dia = match[1].padStart(2, "0");
      const mes = match[2].padStart(2, "0");
      const anio = match[3] ? (match[3].length === 2 ? "20" + match[3] : match[3]) : new Date().getFullYear();
      fecha = `${dia}/${mes}/${anio}`;
      continue;
    }

    // Detectar líneas con descripción y monto al final
    // Acepta números con punto o coma como separador de miles: 17500, 17.500, 17,500
    const matchGasto = linea.match(/^(.+?)\s+([\d.,]+)\s*$/);
    if (matchGasto) {
      const descripcion = matchGasto[1].trim();
      const montoStr = matchGasto[2].replace(/\./g, "").replace(/,/g, "");
      const monto = parseFloat(montoStr);
      if (!isNaN(monto)) {
        gastos.push({ descripcion, monto });
      }
    }
  }

  return { fecha, gastos };
}

async function ultimaFechaDelSheet() {
  try {
    const sheets = google.sheets({ version: "v4", auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Hoja1!A:A",
    });
    const filas = res.data.values || [];
    // La última fila con valor (saltear header si existe)
    for (let i = filas.length - 1; i >= 0; i--) {
      const val = filas[i][0];
      if (val && /\d{1,2}\/\d{1,2}/.test(val)) return val;
    }
  } catch (e) {
    console.error("Error leyendo última fecha:", e);
  }
  return null;
}

app.get("/", (req, res) => res.send("Bot de gastos activo ✅"));

app.post("/webhook", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const { Body } = req.body;

    if (!Body) {
      twiml.message("Enviame los gastos así:\n\n2/3\nAlmuerzo 350\nNafta 8000");
      return res.type("text/xml").send(twiml.toString());
    }

    const { fecha: fechaParsed, gastos } = parsearMensaje(Body);

    if (gastos.length === 0) {
      twiml.message("No encontré gastos. Enviame así:\n\n2/3\nAlmuerzo 350\nNafta 8000");
      return res.type("text/xml").send(twiml.toString());
    }

    // Si no hay fecha en el mensaje, buscar la última del sheet
    let fecha = fechaParsed;
    if (!fecha) {
      fecha = await ultimaFechaDelSheet();
    }
    // Si tampoco hay en el sheet, usar hoy
    if (!fecha) {
      fecha = fechaHoy();
    }

    const timestamp = new Date().toLocaleString("es-AR", TZ);
    const sheets = google.sheets({ version: "v4", auth });

    const filas = gastos.map(g => [fecha, g.descripcion, g.monto, timestamp]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Hoja1!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: filas },
    });

    // Armar respuesta
    const total = gastos.reduce((sum, g) => sum + g.monto, 0);
    const detalles = gastos.map(g => `  • ${g.descripcion}: $${g.monto.toLocaleString("es-AR")}`).join("\n");

    twiml.message(
      `✅ ${gastos.length} gasto${gastos.length > 1 ? "s" : ""} registrado${gastos.length > 1 ? "s" : ""}!\n` +
      `📅 ${fecha}\n\n` +
      `${detalles}\n\n` +
      `💰 Total: $${total.toLocaleString("es-AR")}`
    );

  } catch (err) {
    console.error("Error:", err);
    twiml.message("❌ Hubo un error al registrar. Intentá de nuevo.");
  }

  res.type("text/xml").send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
