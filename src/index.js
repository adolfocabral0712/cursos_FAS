const BASE = "https://www.fas.com.uy";
const LOGIN = BASE + "/backoffice/login/";
const CURSOS = BASE + "/capacitaciones/estado_cursos/";

const normal = value => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

const limpiar = value => String(value ?? "")
  .replace(/\s+/g, " ")
  .trim();

let sesionGuardada = null;
let iniciandoSesion = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function destinoPermitido(value) {
  const url = new URL(value, BASE);

  if (url.origin !== BASE) {
    throw new Error("FAS devolvió un enlace a un dominio inesperado.");
  }

  url.hash = "";
  return url;
}

async function pedir(jar, value, opciones = {}) {
  let url = destinoPermitido(value);
  let method = opciones.method || "GET";
  let body = opciones.body;

  for (let salto = 0; salto < 10; salto++) {
    const headers = new Headers(opciones.headers || {});

    headers.set("User-Agent", "Mozilla/5.0");
    headers.set("Accept", "text/html,application/xhtml+xml");
    headers.set(
      "Cookie",
      [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
    );

    const response = await fetch(url.href, {
      method,
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(45000)
    });

    const cookies = response.headers.getAll("Set-Cookie");

    for (const cookie of cookies) {
      const par = cookie.split(";")[0];
      const separador = par.indexOf("=");

      if (separador > 0) {
        jar.set(
          par.slice(0, separador).trim(),
          par.slice(separador + 1)
        );
      }
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");

      if (!location) {
        throw new Error("FAS devolvió una redirección sin destino.");
      }

      const siguiente = new URL(location, url);
      destinoPermitido(siguiente.href);
      await response.body?.cancel();

      if (
        response.status === 303 ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }

      url = siguiente;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`FAS respondió con error HTTP ${response.status}.`);
    }

    return {
      html: await response.text(),
      url: url.href
    };
  }

  throw new Error("FAS devolvió demasiadas redirecciones.");
}

async function analizar(html) {
  const resultado = {
    formularios: [],
    cursos: [],
    encabezados: [],
    filas: [],
    enlaces: [],
    password: false,
    tabla: false
  };

  let formulario = null;
  let curso = null;
  let fila = null;
  let celda = null;
  let encabezado = null;

  const rewriter = new HTMLRewriter()
    .on("form", {
      element(e) {
        const actual = {
          action: e.getAttribute("action") || "",
          campos: {},
          usuario: null,
          password: null
        };

        resultado.formularios.push(actual);
        formulario = actual;

        e.onEndTag(() => {
          if (formulario === actual) formulario = null;
        });
      }
    })
    .on("input", {
      element(e) {
        const tipo = normal(e.getAttribute("type") || "text");
        const nombre = e.getAttribute("name");

        if (tipo === "password") resultado.password = true;
        if (!formulario || !nombre) return;

        if (tipo === "hidden") {
          formulario.campos[nombre] = e.getAttribute("value") || "";
        }

        if (["text", "email"].includes(tipo) && !formulario.usuario) {
          formulario.usuario = nombre;
        }

        if (tipo === "password") {
          formulario.password = nombre;
        }
      }
    })
    .on(
      'select[name="course"] option, select#id_course option, select#course option',
      {
        element(e) {
          const actual = {
            id: e.getAttribute("value") || "",
            nombre: ""
          };

          curso = actual;

          e.onEndTag(() => {
            actual.nombre = limpiar(actual.nombre);

            if (/^\d+$/.test(actual.id)) {
              resultado.cursos.push(actual);
            }

            if (curso === actual) curso = null;
          });
        },
        text(t) {
          if (curso) curso.nombre += t.text;
        }
      }
    )
    .on("table#trainees", {
      element() {
        resultado.tabla = true;
      }
    })
    .on("table#trainees thead th", {
      element(e) {
        const actual = { texto: "" };
        encabezado = actual;

        e.onEndTag(() => {
          resultado.encabezados.push(limpiar(actual.texto));
          if (encabezado === actual) encabezado = null;
        });
      },
      text(t) {
        if (encabezado) encabezado.texto += t.text;
      }
    })
    .on("table#trainees tbody tr", {
      element(e) {
        const actual = [];
        fila = actual;

        e.onEndTag(() => {
          if (actual.length) resultado.filas.push(actual);
          if (fila === actual) fila = null;
        });
      }
    })
    .on("table#trainees tbody td", {
      element(e) {
        const actual = { texto: "", fila };
        celda = actual;

        e.onEndTag(() => {
          if (actual.fila) {
            actual.fila.push(limpiar(actual.texto));
          }

          if (celda === actual) celda = null;
        });
      },
      text(t) {
        if (celda) celda.texto += t.text;
      }
    })
    .on(
      '.pagination a[href], .pager a[href], a[rel="next"][href]',
      {
        element(e) {
          if (e.getAttribute("aria-disabled") !== "true") {
            resultado.enlaces.push(e.getAttribute("href"));
          }
        }
      }
    );

  await rewriter.transform(new Response(html)).text();
  return resultado;
}

async function iniciarSesion(env) {
  if (!env.FAS_USUARIO || !env.FAS_PASSWORD) {
    throw new Error(
      "Faltan los secretos FAS_USUARIO y FAS_PASSWORD en Cloudflare."
    );
  }

  const jar = new Map();
  const acceso = await pedir(jar, LOGIN);
  const pagina = await analizar(acceso.html);
  const form = pagina.formularios.find(f => f.password);

  if (!form) {
    throw new Error("No se encontró el formulario de acceso de FAS.");
  }

  const datos = new URLSearchParams(form.campos);

  datos.set(form.usuario || "username", env.FAS_USUARIO);
  datos.set(form.password, env.FAS_PASSWORD);
  datos.set("next", new URL(CURSOS).pathname);

  const destino = new URL(form.action || acceso.url, acceso.url);
  destinoPermitido(destino.href);

  await pedir(jar, destino.href, {
    method: "POST",
    body: datos.toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": acceso.url
    }
  });

  const comprobacion = await pedir(jar, CURSOS);
  const contenido = await analizar(comprobacion.html);

  if (contenido.password) {
    throw new Error(
      "FAS no permitió iniciar sesión. Revisá usuario y contraseña."
    );
  }

  return {
    jar,
    vence: Date.now() + 10 * 60 * 1000
  };
}

async function obtenerSesion(env) {
  if (sesionGuardada && sesionGuardada.vence > Date.now()) {
    return sesionGuardada;
  }

  if (!iniciandoSesion) {
    iniciandoSesion = iniciarSesion(env)
      .then(sesion => {
        sesionGuardada = sesion;
        return sesion;
      })
      .finally(() => {
        iniciandoSesion = null;
      });
  }

  return iniciandoSesion;
}

async function leerPagina(env, url) {
  for (let intento = 0; intento < 2; intento++) {
    const sesion = await obtenerSesion(env);
    const respuesta = await pedir(sesion.jar, url);
    const contenido = await analizar(respuesta.html);

    if (!contenido.password) {
      return {
        ...contenido,
        url: respuesta.url
      };
    }

    sesionGuardada = null;
  }

  throw new Error("La sesión de FAS venció y no se pudo recuperar.");
}

const CAMPOS = [
  ["contratista", "Contratista / Integrante"],
  ["nombre", "Nombre"],
  ["ci", "CI"],
  ["curso", "Curso"],
  ["estado", "Estado"],
  ["tiempo_restante", "Tiempo restante"],
  ["plazo", "Plazo"],
  ["puntaje", "Puntaje"],
  ["fecha_aprobacion", "Fecha aprobación"],
  ["validez", "Validez"]
];

function convertirFilas(pagina) {
  if (!pagina.tabla) {
    throw new Error(
      "FAS no devolvió la tabla trainees. Puede haber cambiado la página."
    );
  }

  const indices = new Map(
    pagina.encabezados.map((nombre, i) => [normal(nombre), i])
  );

  for (const nombre of ["CI", "Curso", "Estado"]) {
    if (!indices.has(normal(nombre))) {
      throw new Error(
        `No se encontró la columna "${nombre}" en la tabla de FAS.`
      );
    }
  }

  const registros = [];

  for (const valores of pagina.filas) {
    // Las filas de “sin resultados” tienen una única celda.
    if (valores.length < 3) continue;

    const registro = {};

    for (const [campo, titulo] of CAMPOS) {
      const indice = indices.get(normal(titulo));
      registro[campo] = indice === undefined
        ? ""
        : valores[indice] || "";
    }

    if (!registro.curso && !registro.ci && !registro.nombre) continue;

    registros.push(registro);
  }

  return registros;
}

function enlaceDePagina(value, cursoId) {
  const url = destinoPermitido(value);

  if (
    url.pathname.replace(/\/+$/, "") !==
    new URL(CURSOS).pathname.replace(/\/+$/, "")
  ) {
    throw new Error("El enlace no corresponde al listado de cursos.");
  }

  url.searchParams.set("course", cursoId);
  url.searchParams.sort();
  url.hash = "";

  return url.href;
}

async function autorizado(request, env) {
  if (!env.PANEL_CLAVE) {
    return json(
      { error: "Falta configurar el secreto PANEL_CLAVE." },
      503
    );
  }

  const clave = request.headers.get("X-Panel-Clave") || "";
  const encoder = new TextEncoder();

  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(clave)),
    crypto.subtle.digest("SHA-256", encoder.encode(env.PANEL_CLAVE))
  ]);

  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diferencia = 0;

  for (let i = 0; i < aa.length; i++) diferencia |= aa[i] ^ bb[i];

  if (diferencia) {
    return json({ error: "La clave de consulta no es correcta." }, 401);
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "GET") {
      return json({ error: "Método no permitido." }, 405);
    }

    const bloqueo = await autorizado(request, env);
    if (bloqueo) return bloqueo;

    try {
      if (url.pathname === "/api/catalogo") {
        const pagina = await leerPagina(env, CURSOS);

        const cursos = [...new Map(
          pagina.cursos.map(c => [c.id, c])
        ).values()];

        if (!cursos.length) {
          throw new Error(
            "No se encontró el selector de cursos de FAS. " +
            "Se necesita revisar el HTML de esa página para detectar todos los cursos."
          );
        }

        return json({ cursos });
      }

      if (url.pathname === "/api/pagina") {
        const cursoId = url.searchParams.get("curso") || "";

        if (!/^\d+$/.test(cursoId)) {
          return json({ error: "Identificador de curso incorrecto." }, 400);
        }

        const destino = enlaceDePagina(
          url.searchParams.get("url") || CURSOS,
          cursoId
        );

        const pagina = await leerPagina(env, destino);
        const registros = convertirFilas(pagina);
        const enlaces = [];

        for (const href of pagina.enlaces) {
          try {
            enlaces.push(
              enlaceDePagina(new URL(href, pagina.url).href, cursoId)
            );
          } catch {
            // Ignora enlaces ajenos al listado.
          }
        }

        return json({
          url: enlaceDePagina(pagina.url, cursoId),
          registros,
          enlaces: [...new Set(enlaces)],
          consultado: new Date().toISOString()
        });
      }

      return json({ error: "Ruta no encontrada." }, 404);
    } catch (error) {
      return json({
        error: error.message || "No se pudo consultar FAS."
      }, 502);
    }
  }
};
