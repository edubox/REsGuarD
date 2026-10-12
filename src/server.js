import { cargarConfig } from './config.js';
import { crearServicio } from './servicio.js';

const config = cargarConfig();
const { app, planificador } = await crearServicio({ config });

app.listen(config.puerto, () => {
  console.log(`REsGuarD escuchando en el puerto ${config.puerto}`);
  planificador.iniciar();
});
