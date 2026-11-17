# Intercambio de textos · Frontend (HTML + CSS + JavaScript)

Web estática para un intercambio aleatorio y anónimo de textos. Habla **solo** con las dos Edge Functions de Supabase del backend (`intercambio-public` e `intercambio-admin`); nunca consulta tablas. No usa frameworks, datos de ejemplo ni almacenamiento del navegador.

## 1. Archivos y dónde colocarlos en VS Code

Crea una carpeta (por ejemplo `intercambio-web`), ábrela con **Archivo > Abrir carpeta** y deja dentro estos cinco archivos, todos al mismo nivel:

```
intercambio-web/
  index.html    estructura de las dos zonas (participantes y administración)
  styles.css    diseño (claro/oscuro automático, responsive)
  script.js     lógica y conexión con Supabase
  config.js     ÚNICO archivo que debes editar (datos públicos)
  README.md     estas instrucciones
```

## 2. Configurar las credenciales públicas

Abre `config.js` y rellena:

| Campo | De dónde sale |
|---|---|
| `SUPABASE_URL` | Panel de Supabase > Project Settings > API > **Project URL** |
| `SUPABASE_ANON_KEY` | Misma pantalla: clave **anon / public** (o *publishable*). Es pública por diseño |
| `EVENT_SLUG` | El slug con el que creaste el evento (p. ej. `mi-evento`) |
| `USE_PIN` | `true` (por defecto): muestra el campo PIN (4 a 8 dígitos, opcional para cada participante). `false`: el nombre es la única clave |
| `POLL_SECONDS` | Cada cuántos segundos se refresca el estado (mínimo 5) |

**Nunca** pongas en estos archivos la clave `service_role` ni el `ADMIN_TOKEN`: cualquiera que abra la web puede leerlos. La credencial de administración se teclea en la web y solo vive en memoria.

### Requisitos del backend

- Las dos Edge Functions desplegadas **con «Verify JWT» desactivado** (la admin se protege con `x-admin-token`).
- Secret `ALLOWED_ORIGIN` con el origen exacto desde el que se sirve la web (sin barra final), p. ej. `https://tu-sitio.netlify.app`. Para probar en local: `http://localhost:5500` (el puerto de Live Server).
- El evento creado, por ejemplo en el Editor SQL:
  `select public.admin_create_event('mi-evento', 'Mi evento', 10, 2000, true);`

## 3. Ejecutarla

- **En local:** instala la extensión *Live Server* de VS Code, clic derecho en `index.html` > *Open with Live Server*. (No abras el archivo con doble clic: el origen `file://` no encaja con CORS.) Pon ese origen en `ALLOWED_ORIGIN`.
- **En Netlify:** sigue la guía paso a paso `DESPLIEGUE.md` (en la carpeta superior). Resumen: arrastra esta carpeta a Netlify con la sesión iniciada y, después, pon tu URL en el secret `ALLOWED_ORIGIN` de Supabase. La carpeta incluye `_headers` (cabeceras de seguridad) y `netlify.toml`.

## 4. Cómo funciona

**Participantes** (`#/`): estado del reparto (*Pendiente*, *Preparado*, *Realizado*), nº de participantes y mínimo, formulario de registro y consulta del resultado por nombre.

- *Pendiente*: aún no se alcanza el mínimo. *Preparado*: se alcanzó el mínimo y el reparto está listo (en modo manual, a la espera del administrador). *Realizado*: ya repartido; el registro se cierra.
- El resultado muestra solo el texto asignado, nunca el autor, y desaparece si cambias el nombre del campo.

**Administración** (`#/admin`): acceso con la credencial `ADMIN_TOKEN`, comprobada en el servidor en cada operación. Permite ver participantes / mínimo / cuántos faltan, cambiar el mínimo, activar o desactivar el reparto automático y repartir a mano (también antes de alcanzar el mínimo, con al menos 2 participantes). Con el evento repartido, todo queda bloqueado. Si una configuración provocaría un reparto inmediato (automático activado y mínimo ya alcanzado), la web lo avisa y pide confirmación.

## 5. Cómo probar todo

1. **Participantes:** abre la web, envía el formulario vacío (debe avisar), registra a «Ana»; vuelve a registrar «ana» (debe decir que el nombre ya existe). Consulta «Ana» antes del reparto: «todavía no está disponible».
2. **Reparto automático:** con el automático activado y un mínimo bajo (3, por ejemplo), registra participantes hasta alcanzarlo. El estado pasa a *Realizado* y cada uno ve un texto que no es el suyo.
3. **Modo manual:** crea otro evento con `auto_distribute = false`. Al alcanzar el mínimo seguirá *Preparado* sin repartir. En `#/admin`, pulsa «Iniciar reparto ahora» y confirma.
4. **Reparto anticipado:** con menos participantes que el mínimo (pero 2 o más), el administrador puede repartir igualmente.
5. **Mínimo y modo:** cambia el mínimo y activa/desactiva el automático; comprueba que solo reparte si el modo está activado.
6. **Bloqueos:** con el evento repartido, el botón de repartir y la configuración están desactivados, y un segundo reparto por API devuelve `ALREADY_DISTRIBUTED`.
7. **PIN (activado por defecto):** registra a alguien con PIN y comprueba que sin PIN o con otro no puede ver su texto. Quien se registra sin PIN sigue pudiendo consultar solo con su nombre. Un PIN olvidado no se puede recuperar (se guarda cifrado): habría que reiniciar el evento.

## 6. Errores habituales

| Síntoma | Causa y solución |
|---|---|
| Aviso rojo «Falta configurar SUPABASE_URL / SUPABASE_ANON_KEY» | `config.js` sin rellenar o con el valor de ejemplo |
| «No se pudo cargar el SDK de Supabase» | Sin conexión a `cdn.jsdelivr.net`, o el navegador rechazó la comprobación de integridad. Si usas otra versión del SDK, cambia la versión **y** el atributo `integrity` de `index.html` (o quita `integrity`/`crossorigin` bajo tu responsabilidad), o descarga `supabase.js` y sírvelo como archivo propio |
| «No se pudo conectar con el servidor» | Fallo de red o CORS: revisa que `ALLOWED_ORIGIN` coincida exactamente con el origen de la web (incluye `http`/`https` y puerto) |
| «Supabase rechazó la petición…» | Clave anónima incorrecta, o «Verify JWT» activado en las Edge Functions |
| «El evento no existe» | `EVENT_SLUG` no coincide con un evento creado. En administración se muestra el SQL para crearlo |
| «Credencial de administrador no válida» | `ADMIN_TOKEN` distinto del secret del servidor, o menor de 24 caracteres (la función lo rechaza). Revisa los secrets y vuelve a desplegar |
| «Demasiados intentos» | Límite por conexión (20 registros / 40 consultas cada 10 min). Espera unos minutos |
| «El registro está cerrado» | El reparto ya se hizo; es definitivo |
| Todo carga pero el contador no cambia | Se actualiza cada `POLL_SECONDS` s; pulsa «Actualizar estado» |
| CSP bloquea conexiones con un dominio propio de Supabase | Añádelo a `connect-src` en la etiqueta `<meta http-equiv="Content-Security-Policy">` de `index.html` |

## 7. Limitaciones que conviene conocer

- **El nombre no acredita identidad** (versión 1): quien conozca un nombre puede consultar su resultado. Con `USE_PIN: true` (por defecto) cada participante puede añadir un PIN como barrera adicional, pero es opcional: quien no lo ponga queda protegido solo por su nombre. La interfaz muestra un solo resultado a la vez, pero no puede impedir que alguien pruebe nombres: la protección real está en el servidor (límite de intentos y PIN).
- «Solo una vez por evento» se controla por nombre: una persona podría registrarse con dos nombres distintos.
- Sin PIN, quien tenga el enlace puede intentar la credencial de administrador: usa un `ADMIN_TOKEN` largo y aleatorio (`openssl rand -hex 32`).
- El estado se actualiza por sondeo periódico, no en tiempo real.
