/*
 * CONFIGURACIÓN PÚBLICA
 * ---------------------
 * Aquí solo van datos públicos. NUNCA pongas la clave service_role, el
 * ADMIN_TOKEN ni ninguna otra clave secreta en este archivo: cualquiera que
 * visite la web puede leerlo.
 *
 * Dónde encontrar los valores (panel de Supabase > Project Settings > API):
 *   SUPABASE_URL      -> "Project URL"
 *   SUPABASE_ANON_KEY -> clave "anon" / "public" (o "publishable" en proyectos nuevos)
 */
window.APP_CONFIG = {
  SUPABASE_URL: "https://fgonbhuyvunvewyhacro.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_nKDFpwP9YvIt-P1a8Ah_yA_gTclHlkE",

  // Slug del evento creado con public.admin_create_event(...) en Supabase
  EVENT_SLUG: "mi-evento",

  // true (por defecto): muestra el campo PIN (4 a 8 dígitos) al participar y al consultar.
  //   Quien pone un PIN tendrá que introducirlo para ver su resultado; el servidor lo guarda
  //   cifrado (bcrypt) y no se puede recuperar. El PIN es opcional para cada participante.
  // false: el nombre es la única clave de consulta (aun así, si un participante tiene PIN,
  //   la web lo pedirá sola).class="playwrite-au">«Ruego, pues, lo primero de todo, que se hagan peticiones, oraciones, súplicas y acciones de gracias por todos los hombres». - <i>1&nbsp;Tim&nbsp;2,1</i>
  USE_PIN: true,

  // Cada cuántos segundos se actualiza el estado en pantalla (mínimo 5) 
  POLL_SECONDS: 15
};