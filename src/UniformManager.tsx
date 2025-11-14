import React, { useState, useEffect, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, Timestamp, query, onSnapshot } from 'firebase/firestore';
import { Camera, Clipboard, Factory, CheckCircle, AlertTriangle, Loader, Users, Upload, Tag, User, Flame, Zap, BarChart2, List } from 'lucide-react';

// --- Global Variable Declarations (Mandatory for Canvas Environment) ---
const appId = 'default-app-id';
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};
const initialAuthToken = null;

// Utility function to convert File/Blob to Base64 string
const fileToBase64 = (file:any) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = (error) => reject(error);
  });
};

// Utility function for exponential backoff
const withBackoff = async (fn:any, maxRetries = 5, delay = 1000) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay * (2 ** i)}ms...`, error);
            await new Promise(resolve => setTimeout(resolve, delay * (2 ** i)));
        }
    }
};

// --- CONSTANTS ---
const CLOTHING_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const FOOTWEAR_SIZES = ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44'];

const COLOR_OPTIONS = ['Amarillo', 'Anaranjado', 'Azulino', 'Azul Marino', 'Celeste', 'ENTRENAMIENTO'];

const AREA_OPTIONS = [
    'PRODUCCIÓN', 
    'ARTES GRÁFICAS', 
    'MANTENIMIENTO', 
    'CONTROL DE CALIDAD', 
    'SANEAMIENTO', 
    'RECURSOS HUMANOS', 
    'ÁREAS ADMINISTRATIVAS',
    'Externo (proveedores, visitas)'
];

const REASON_OPTIONS = [
  { key: 'RENOVACION_3M', label: 'Renovación de 3 meses', requiresPhoto: false },
  { key: 'RENOVACION_ANUAL', label: 'Renovación anual', requiresPhoto: false },
  { key: 'SEGUNDO_JUEGO_ENTRENAMIENTO', label: 'Segundo juego de entrenamiento', requiresPhoto: false },
  { key: 'ACCIDENTE_DESGASTE', label: 'Cambio por accidentes o desgaste', requiresPhoto: true },
];

const UNIFORM_ITEMS = {
    // Prendas de Vestir - Requires Size & Color
    polos: { label: 'Polos', sizes: CLOTHING_SIZES, category: 'prendas' },
    pantalon: { label: 'Pantalón de Trabajo', sizes: CLOTHING_SIZES, category: 'prendas' },
    chaqueta: { label: 'Chaqueta', sizes: CLOTHING_SIZES, category: 'prendas' },
    // Tocas - Size is 'Única' and selection will be removed in the UI
    tocas: { label: 'Tocas', sizes: ['Única'], category: 'prendas' }, 
    // Zapatos - Requires Size only
    mecanico: { label: 'Zapato Mecánico', sizes: FOOTWEAR_SIZES, category: 'zapatos' },
    dielectrico: { label: 'Zapato Dieléctrico', sizes: FOOTWEAR_SIZES, category: 'zapatos' },
};


// --- APPLICATION START ---

export default function UniformManager() {
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const initialFormState = {
    employeeName: '', // MANDATORY
    area: '', // MANDATORY
    reasonKey: 'RENOVACION_3M', // Default to 3-month renewal
    damageNotes: '', // Kept in state but removed from UI (optional field)
    photoFile: null,
    items: {
      polos: { size: '', quantity: 0, color: '' },
      pantalon: { size: '', quantity: 0, color: '' },
      chaqueta: { size: '', quantity: 0, color: '' },
      tocas: { size: 'Única', quantity: 0, color: '' }, // Size is 'Única' by default
      mecanico: { size: '', quantity: 0 },
      dielectrico: { size: '', quantity: 0 },
    }
  };
  const [formData, setFormData] = useState(initialFormState);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [deliveries, setDeliveries] = useState([]);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  // New state for Admin Panel Tab
  const [adminView, setAdminView] = useState('VISUALIZATION'); // 'VISUALIZATION' or 'HISTORY'

  // Derived State
  const currentReason = REASON_OPTIONS.find(r => r.key === formData.reasonKey);
  const requiresPhoto = currentReason ? currentReason.requiresPhoto : false;
  const reasonLabel = currentReason ? currentReason.label : '';

  // --- FIREBASE INITIALIZATION & AUTHENTICATION ---
  useEffect(() => {
    const setupFirebase = async () => {
      try {
        const app = initializeApp(firebaseConfig);
        const firestore = getFirestore(app);
        const authInstance = getAuth(app);

        setDb(firestore);
        setAuth(authInstance);

        const unsubscribe = onAuthStateChanged(authInstance, async (user:any) => {
          if (user) {
            setUserId(user.uid);
            setIsAuthReady(true);
            setLoading(false);
          } else {
            if (initialAuthToken) {
              await signInWithCustomToken(authInstance, initialAuthToken);
            } else {
              await signInAnonymously(authInstance);
            }
          }
        });

        return () => unsubscribe();
      } catch (e) {
        console.error("Error al inicializar Firebase:", e);
        setMessage("Error al iniciar la aplicación.");
        setLoading(false);
      }
    };

    if (Object.keys(firebaseConfig).length > 0) {
      setupFirebase();
    } else {
      setLoading(false);
    }
  }, []);

  // --- FIRESTORE DATA PATH & LISTENER ---
  const getDataPath = useCallback(() => {
    return `artifacts/${appId}/public/data/uniform_deliveries`;
  }, []);

  useEffect(() => {
    // Fetch data only if authenticated and the Admin Panel is active
    if (!isAuthReady || !db || !userId) return;

    try {
      const q = query(collection(db, getDataPath()));

      const unsubscribe = onSnapshot(q, (snapshot:any) => {
        const fetchedDeliveries = [];
        snapshot.forEach((doc) => {
          fetchedDeliveries.push({ id: doc.id, ...doc.data() });
        });

        fetchedDeliveries.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());
        setDeliveries(fetchedDeliveries);
      }, (error) => {
        console.error("Error al obtener entregas:", error);
      });

      return () => unsubscribe();
    } catch (e) {
      console.error("Error al configurar el listener de entregas:", e);
    }
  }, [isAuthReady, db, userId, getDataPath]);


  // --- DATA AGGREGATION LOGIC ---
  const aggregateData = useCallback((data) => {
    const areaCounts = {};
    const itemCounts = {};
    const colorCounts = {};
    const reasonCounts = {};
    let totalItems = 0;

    data.forEach(delivery => {
        // Area Count (Count of Requests)
        areaCounts[delivery.area] = (areaCounts[delivery.area] || 0) + 1;

        // Reason Count (Count of Requests)
        reasonCounts[delivery.reason] = (reasonCounts[delivery.reason] || 0) + 1;

        // Item and Color Count (Count of Units)
        delivery.items.forEach(item => {
            const quantity = item.quantity;
            totalItems += quantity;

            // Item Count
            itemCounts[item.item] = (itemCounts[item.item] || 0) + quantity;

            // Color Count (only for garments)
            if (item.category === 'prendas' && item.color && item.color !== 'N/A') {
                colorCounts[item.color] = (colorCounts[item.color] || 0) + quantity;
            }
        });
    });

    return { areaCounts, itemCounts, colorCounts, reasonCounts, totalItems };
  }, []);

  const aggregatedStats = aggregateData(deliveries);

  // --- FORM HANDLERS ---
  const handleGeneralChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleItemChange = (key, field, value) => {
    setFormData(prev => ({
      ...prev,
      items: {
        ...prev.items,
        [key]: { ...prev.items[key], [field]: value }
      }
    }));
  };

  const handlePhotoCapture = (e) => {
    const file = e.target.files[0];
    if (file) {
      setFormData(prev => ({ ...prev, photoFile: file }));
    } else {
      setFormData(prev => ({ ...prev, photoFile: null }));
    }
  };

  // --- SUBMISSION LOGIC ---
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isSubmitting || !db) return;

    // 1. Primary Validations (Name and Area)
    if (!formData.employeeName) {
      setMessage("Por favor, complete el campo 'Nombre Completo', es obligatorio.");
      setShowModal(true);
      return;
    }

    if (!formData.area) {
      setMessage("Por favor, complete el campo 'Área', es obligatorio para la identificación.");
      setShowModal(true);
      return;
    }
    
    setIsSubmitting(true);
    setMessage('');

    try {
      let photoBase64 = null;
      if (formData.photoFile) {
        photoBase64 = await fileToBase64(formData.photoFile);
      }

      const itemsToSave = [];
      let itemValidationError = false;

      // 2. Validate Items, Size, and Color
      Object.entries(formData.items).forEach(([key, item]) => {
        const quantity = parseInt(item.quantity, 10);
        
        if (quantity > 0) {
            const itemDef = UNIFORM_ITEMS[key];
            const isTocas = key === 'tocas';
            
            // Validate Size (Mandatory if Quantity > 0)
            if (!isTocas && !item.size) { // Skip size validation for Tocas (already 'Única')
                itemValidationError = `Debe seleccionar la Talla para ${itemDef.label}.`;
            }

            // Validate Color (Mandatory for garments if Quantity > 0)
            if (itemDef.category === 'prendas' && !item.color && !itemValidationError) {
                itemValidationError = `Debe seleccionar el Color para ${itemDef.label}.`;
            }

            if (!itemValidationError) {
                itemsToSave.push({
                    item: itemDef.label,
                    size: isTocas ? 'Única' : item.size, // Force 'Única' for Tocas
                    color: itemDef.category === 'prendas' ? item.color : 'N/A',
                    quantity: quantity,
                    category: itemDef.category,
                    status: requiresPhoto ? 'Cambio por Desgaste/Daño' : reasonLabel
                });
            }
        }
      });

      if (itemValidationError) {
          setMessage(itemValidationError);
          setShowModal(true);
          setIsSubmitting(false);
          return;
      }
      
      if (itemsToSave.length === 0) {
          setMessage("Debe seleccionar al menos un artículo (Prenda o Zapato) para la solicitud.");
          setShowModal(true);
          setIsSubmitting(false);
          return;
      }

      // 3. Photo Validation: Mandatory for 'Accidente/Desgaste' reason
      if (requiresPhoto && !formData.photoFile) {
          setMessage("Para el motivo de 'Cambio por accidentes o desgaste', debe adjuntar obligatoriamente una foto de evidencia.");
          setShowModal(true);
          setIsSubmitting(false);
          return;
      }


      const record = {
        userId,
        employeeName: formData.employeeName,
        area: formData.area,
        reason: reasonLabel,
        reasonKey: formData.reasonKey,
        items: itemsToSave,
        damageNotes: requiresPhoto ? 'Evidencia fotográfica adjunta' : '', // Replaces user notes
        photoBase64: photoBase64,
        timestamp: Timestamp.now(),
      };

      const newDocRef = doc(collection(db, getDataPath()));
      await withBackoff(() => setDoc(newDocRef, record));

      setMessage(`¡Éxito! Solicitud por "${reasonLabel}" enviada correctamente para ${formData.employeeName} (${formData.area}).`);
      setShowModal(true);
      setFormData(initialFormState); // Reset form
      document.getElementById('photo-input').value = ''; // Clear file input
    } catch (error) {
      console.error("Error al enviar el formulario:", error);
      setMessage("Error al guardar los datos. Intente de nuevo.");
      setShowModal(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  // --- UI COMPONENTS (DataVisualization) ---

  const Bar = ({ label, value, max, unit = '', color }) => {
    const percentage = max > 0 ? (value / max) * 100 : 0;
    const colorClass = color || (label === 'ENTRENAMIENTO' ? 'bg-yellow-500' : 'bg-sky-500');

    return (
        <div className="mb-4">
            <div className="flex justify-between items-center mb-1">
                <span className="text-sm font-medium text-gray-700 truncate">{label}</span>
                <span className="text-xs font-bold text-gray-900">{value} {unit}</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-4">
                <div
                    className={`h-4 rounded-full transition-all duration-700 ${colorClass}`}
                    style={{ width: `${percentage}%` }}
                    title={`${label}: ${value} ${unit}`}
                ></div>
            </div>
        </div>
    );
  };

  const DataVisualization = ({ stats, data }) => {
    const { areaCounts, colorCounts, totalItems } = stats;

    if (totalItems === 0) {
        return (
            <div className="text-center py-8 text-gray-500">
                Aún no hay suficientes datos para generar visualizaciones.
            </div>
        );
    }

    // Prepare data for charts
    const areas = Object.entries(areaCounts).sort(([, a], [, b]) => b - a);
    const colors = Object.entries(colorCounts).sort(([, a], [, b]) => b - a);
    const reasons = Object.entries(stats.reasonCounts).sort(([, a], [, b]) => b - a);

    // Calculate max value for bar scaling
    const maxAreaCount = areas.length > 0 ? areas[0][1] : 1;
    const maxColorCount = colors.length > 0 ? colors[0][1] : 1;
    const maxReasonCount = reasons.length > 0 ? reasons[0][1] : 1;


    return (
        <div className="space-y-8">
            <h2 className="text-2xl font-bold text-gray-900 border-b pb-3 mb-4">
                <BarChart2 className="inline-block w-6 h-6 mr-2 text-sky-600"/> Resumen y Análisis de Datos
            </h2>
            
            {/* Métricas Globales */}
            <h3 className="text-lg font-semibold text-gray-700">Métricas Globales</h3>
            <div className="grid grid-cols-2 gap-4 text-center">
                <div className="p-4 bg-sky-100 rounded-xl shadow-sm">
                    <p className="text-3xl font-extrabold text-sky-800">{data.length}</p>
                    <p className="text-sm text-sky-600">Solicitudes Registradas</p>
                </div>
                <div className="p-4 bg-gray-100 rounded-xl shadow-sm">
                    <p className="text-3xl font-extrabold text-gray-800">{totalItems}</p>
                    <p className="text-sm text-gray-600">Total Artículos Solicitados</p>
                </div>
            </div>

            {/* Reason Distribution Chart */}
            <div>
                <h3 className="text-lg font-semibold text-gray-700 mb-4 mt-6">Motivos de Solicitud</h3>
                <div className="p-4 bg-white border border-gray-200 rounded-xl shadow-md">
                    {reasons.map(([reason, count]) => (
                        <Bar 
                            key={reason} 
                            label={reason} 
                            value={count} 
                            max={maxReasonCount} 
                            unit='Solicitudes' 
                            color={reason.includes('accidente') ? 'bg-red-500' : 'bg-green-500'}
                        />
                    ))}
                </div>
            </div>

            {/* Area Distribution Chart */}
            <div>
                <h3 className="text-lg font-semibold text-gray-700 mb-4 mt-6">Distribución de Solicitudes por Área</h3>
                <div className="p-4 bg-white border border-gray-200 rounded-xl shadow-md">
                    {areas.map(([area, count]) => (
                        <Bar key={area} label={area} value={count} max={maxAreaCount} unit='Solicitudes' />
                    ))}
                </div>
            </div>

            {/* Color Distribution Chart */}
            <div>
                <h3 className="text-lg font-semibold text-gray-700 mb-4 mt-6">Distribución de Prendas por Color (Unidades)</h3>
                <div className="p-4 bg-white border border-gray-200 rounded-xl shadow-md">
                    {colors.map(([color, count]) => (
                        <Bar 
                            key={color} 
                            label={color} 
                            value={count} 
                            max={maxColorCount} 
                            unit='Unidades'
                            // Custom color based on the uniform color (simple approximations)
                            color={
                                color === 'Amarillo' ? 'bg-yellow-400' :
                                color === 'Anaranjado' ? 'bg-orange-500' :
                                color === 'Azulino' ? 'bg-blue-600' :
                                color === 'Azul Marino' ? 'bg-indigo-800' :
                                color === 'Celeste' ? 'bg-cyan-400' :
                                color === 'ENTRENAMIENTO' ? 'bg-lime-500' : 'bg-gray-400'
                            }
                        />
                    ))}
                </div>
            </div>
        </div>
    );
  };
  
  // --- UI COMPONENTS (ItemSelector) ---

  const ItemSelector = ({ itemKey, label, sizes }) => {
    const itemData = formData.items[itemKey];
    const itemDef = UNIFORM_ITEMS[itemKey];
    const isGarment = itemDef.category === 'prendas';
    // Identificar si es Tocas para ocultar talla
    const isTocas = itemKey === 'tocas'; 

    return (
      <div className={`p-4 rounded-xl border-2 transition-all ${itemData.quantity > 0 ? 'border-sky-500 bg-sky-50 shadow-md' : 'border-gray-200 bg-white hover:border-sky-300'}`}>
        <h3 className="text-md font-semibold text-gray-800">{label}</h3>
        
        <div className="mt-2 grid grid-cols-3 gap-2">
          
          {/* Quantity - Adjusted col-span for Tocas */}
          <div className={`${isGarment ? (isTocas ? 'col-span-2' : 'col-span-1') : 'col-span-2'}`}>
            <label htmlFor={`${itemKey}-qty`} className="block text-xs font-medium text-gray-600">Cant.</label>
            <input
              id={`${itemKey}-qty`}
              type="number"
              min="0"
              max="10"
              className="mt-1 w-full p-2 border border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500 text-center text-sm"
              value={itemData.quantity}
              onChange={(e) => handleItemChange(itemKey, 'quantity', e.target.value)}
            />
          </div>
          
          {/* Size (Talla) - Hidden for Tocas */}
          {!isTocas && (
            <div className={`${isGarment ? 'col-span-1' : 'col-span-1'}`}>
              <label htmlFor={`${itemKey}-size`} className="block text-xs font-medium text-gray-600">Talla {itemData.quantity > 0 && itemData.size === '' && (<span className="text-red-500">*</span>)}</label>
              <select
                id={`${itemKey}-size`}
                className="mt-1 w-full p-2 border border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500 bg-white text-sm"
                value={itemData.size}
                onChange={(e) => handleItemChange(itemKey, 'size', e.target.value)}
                disabled={itemData.quantity === 0}
              >
                <option value="">Sel.</option>
                {sizes.map(size => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </div>
          )}

          {/* Color (Only for Garments) - Adjusted col-span for Tocas */}
          {isGarment && (
            <div className={`${isTocas ? 'col-span-1' : 'col-span-1'}`}>
                <label htmlFor={`${itemKey}-color`} className="block text-xs font-medium text-gray-600">Color {itemData.quantity > 0 && itemData.color === '' && (<span className="text-red-500">*</span>)}</label>
                <select
                id={`${itemKey}-color`}
                className="mt-1 w-full p-2 border border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500 bg-white text-sm"
                value={itemData.color}
                onChange={(e) => handleItemChange(itemKey, 'color', e.target.value)}
                disabled={itemData.quantity === 0}
                >
                <option value="">Sel.</option>
                {COLOR_OPTIONS.map(color => (
                    <option key={color} value={color}>{color}</option>
                ))}
                </select>
            </div>
          )}
        </div>
      </div>
    );
  };

  const Modal = ({ message, onClose }) => (
    <div className="fixed inset-0 bg-gray-900 bg-opacity-75 flex items-center justify-center p-4 z-50 transition-opacity duration-300">
      <div className="bg-white rounded-xl p-6 w-full max-w-sm shadow-2xl transform scale-100 transition-transform duration-300">
        <div className="flex flex-col items-center">
          {message.includes('Éxito') ? (
            <CheckCircle className="w-12 h-12 text-sky-500 mb-4" />
          ) : (
            <AlertTriangle className="w-12 h-12 text-red-500 mb-4" />
          )}
          <h3 className="text-xl font-bold text-gray-900 text-center mb-4">
            {message.includes('Éxito') ? 'Operación Exitosa' : 'Atención Requerida'}
          </h3>
          <p className="text-gray-600 text-center mb-6">{message}</p>
          <button
            onClick={onClose}
            className="w-full bg-sky-600 text-white font-bold py-3 px-4 rounded-xl hover:bg-sky-700 transition duration-150 shadow-md"
          >
            Aceptar
          </button>
        </div>
      </div>
    </div>
  );

  const DataRow = ({ data }) => {
    const itemsList = data.items.map(item =>
        `${item.item} (T: ${item.size}, C: ${item.quantity}) - ${item.color !== 'N/A' ? item.color : ''}`.trim()
    ).join(' | ');

    return (
        <div className="bg-white p-4 mb-3 border border-gray-200 rounded-lg shadow-sm">
            <div className="flex justify-between items-start text-sm border-b pb-2 mb-2">
                <div>
                    <p className="font-bold text-lg text-sky-700">{data.area}</p>
                    <p className="text-gray-500 text-xs">Motivo: {data.reason}</p>
                </div>
                <span className={`px-3 py-1 text-xs font-semibold rounded-full ${
                    data.reasonKey === 'ACCIDENTE_DESGASTE' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'
                }`}>
                    {data.reason}
                </span>
            </div>
            {data.employeeName && (
                <p className="text-sm text-gray-700 mt-2">
                    <span className="font-semibold text-sky-700">Nombre:</span> {data.employeeName}
                </p>
            )}
            <p className="text-sm text-gray-700 mt-2">
                <span className="font-semibold">Artículos Solicitados:</span> {itemsList}
            </p>
            {data.damageNotes && (
                <p className="text-sm text-red-600 mt-1">
                    <span className="font-semibold">Notas:</span> {data.damageNotes}
                </p>
            )}
            {data.photoBase64 && (
                <a href={data.photoBase64} target="_blank" rel="noopener noreferrer" className="inline-flex items-center text-sm text-sky-500 hover:text-sky-700 mt-2">
                    <Camera className="w-4 h-4 mr-1"/> Ver Evidencia Adjunta
                </a>
            )}
            <p className="text-xs text-gray-400 mt-2">
                Fecha: {data.timestamp.toDate().toLocaleString()}
            </p>
        </div>
    );
  };

  // --- MAIN APP RENDER ---
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <Loader className="w-8 h-8 animate-spin text-sky-500" />
        <span className="ml-3 text-lg text-gray-700">Cargando aplicación...</span>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-6 font-sans">
      {showModal && <Modal message={message} onClose={() => setShowModal(false)} />}

      {/* Header and User Info */}
      <header className="mb-6 pb-4 border-b border-gray-200 flex justify-between items-center">
          <div>
              <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
                  <Factory className="inline-block w-7 h-7 mr-2 text-sky-600"/> Solicitud de Uniformes
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                  Usuario (ID): <span className="font-mono text-sky-500 text-xs">{userId || 'Anónimo'}</span>
              </p>
          </div>
          <button
              onClick={() => {
                  setShowAdminPanel(prev => !prev);
                  // Reset view to visualization when opening the panel
                  if (!showAdminPanel) setAdminView('VISUALIZATION'); 
              }}
              className="bg-gray-200 text-gray-700 p-2 rounded-full shadow-md hover:bg-gray-300 transition"
              title="Panel Administrador"
          >
              <Users className="w-5 h-5" />
          </button>
      </header>


      {/* Main Panel Content */}
      <div className="max-w-xl mx-auto">
          {showAdminPanel ? (
              // --- ADMIN PANEL VIEW (With Tabs) ---
              <div className="bg-white p-6 rounded-2xl shadow-xl">
                  
                  {/* Tab Navigation */}
                  <div className="flex border-b border-gray-200 mb-6">
                      <button
                          onClick={() => setAdminView('VISUALIZATION')}
                          className={`flex-1 flex items-center justify-center p-3 text-sm font-semibold transition-colors duration-150 ${
                              adminView === 'VISUALIZATION' ? 'text-sky-600 border-b-2 border-sky-600' : 'text-gray-500 hover:text-sky-600'
                          }`}
                      >
                          <BarChart2 className="w-5 h-5 mr-1" /> Visualización de Datos
                      </button>
                      <button
                          onClick={() => setAdminView('HISTORY')}
                          className={`flex-1 flex items-center justify-center p-3 text-sm font-semibold transition-colors duration-150 ${
                              adminView === 'HISTORY' ? 'text-sky-600 border-b-2 border-sky-600' : 'text-gray-500 hover:text-sky-600'
                          }`}
                      >
                          <List className="w-5 h-5 mr-1" /> Historial ({deliveries.length})
                      </button>
                  </div>

                  {/* Tab Content */}
                  <div className="h-96 overflow-y-auto pr-2">
                      {adminView === 'VISUALIZATION' && (
                          <DataVisualization stats={aggregatedStats} data={deliveries} />
                      )}

                      {adminView === 'HISTORY' && (
                          deliveries.length === 0 ? (
                              <p className="text-gray-500 text-center py-10">No hay registros de solicitudes aún.</p>
                          ) : (
                              deliveries.map(data => <DataRow key={data.id} data={data} />)
                          )
                      )}
                  </div>
              </div>

          ) : (
              // --- OPERATIONAL FORM VIEW ---
              <form onSubmit={handleSubmit} className="bg-white p-6 rounded-2xl shadow-xl space-y-6">

                {/* Section 1: Identification & Area (Name is mandatory) */}
                <div className="space-y-4 p-4 border border-sky-300 rounded-xl bg-sky-50">
                    <h2 className="text-xl font-bold text-sky-800 flex items-center">
                        <User className="w-5 h-5 mr-2"/> 1. Identificación del Trabajador
                    </h2>
                    
                    {/* Employee Name (Mandatory and First) */}
                    <div>
                        <label htmlFor="employeeName" className="block text-sm font-medium text-gray-700">Nombre Completo (Obligatorio)</label>
                        <input
                            type="text"
                            name="employeeName"
                            id="employeeName"
                            value={formData.employeeName}
                            onChange={handleGeneralChange}
                            required
                            className="mt-1 block w-full p-3 border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500"
                            placeholder="Ej: Juan Pérez / Nombre del Proveedor"
                        />
                    </div>

                    {/* Area Selector (Mandatory) */}
                    <div>
                        <label htmlFor="area" className="block text-sm font-medium text-gray-700">Área (Requerido)</label>
                        <select
                            name="area"
                            id="area"
                            value={formData.area}
                            onChange={handleGeneralChange}
                            required
                            className="mt-1 block w-full p-3 border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500 bg-white"
                        >
                            <option value="" disabled>Seleccione el área</option>
                            {AREA_OPTIONS.map(area => (
                                <option key={area} value={area}>{area}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {/* Section 2: Prendas de Vestir */}
                <div className="space-y-4 p-4 border border-gray-200 rounded-xl bg-white">
                    <h2 className="text-xl font-bold text-gray-900 flex items-center">
                        <Flame className="w-5 h-5 mr-2 text-sky-600"/> 2. Prendas de Vestir (Polos, Pantalones, etc.)
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {Object.entries(UNIFORM_ITEMS).filter(([, item]) => item.category === 'prendas').map(([key, item]) => (
                        <ItemSelector
                          key={key}
                          itemKey={key}
                          label={item.label}
                          sizes={item.sizes}
                        />
                      ))}
                    </div>
                </div>
                
                {/* Section 3: Zapatos */}
                <div className="space-y-4 p-4 border border-gray-200 rounded-xl bg-white">
                    <h2 className="text-xl font-bold text-gray-900 flex items-center">
                        <Zap className="w-5 h-5 mr-2 text-sky-600"/> 3. Zapatos (Mecánico o Dieléctrico)
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {Object.entries(UNIFORM_ITEMS).filter(([, item]) => item.category === 'zapatos').map(([key, item]) => (
                        <ItemSelector
                          key={key}
                          itemKey={key}
                          label={item.label}
                          sizes={item.sizes}
                        />
                      ))}
                    </div>
                </div>

                {/* Section 4: Reason Selector */}
                <div className="space-y-4 p-4 border border-sky-300 rounded-xl bg-sky-50">
                    <h2 className="text-xl font-bold text-sky-800 flex items-center">
                        <Tag className="w-5 h-5 mr-2"/> 4. Motivo de Solicitud
                    </h2>
                    <div>
                        <label htmlFor="reason" className="block text-sm font-medium text-gray-700">Seleccione el Motivo</label>
                        <select
                            name="reasonKey"
                            id="reason"
                            value={formData.reasonKey}
                            onChange={handleGeneralChange}
                            className="mt-1 block w-full p-3 border-gray-300 rounded-lg shadow-sm focus:ring-sky-500 focus:border-sky-500 bg-white"
                        >
                            {REASON_OPTIONS.map(reason => (
                                <option key={reason.key} value={reason.key}>{reason.label}</option>
                            ))}
                       </select>
                    </div>
                </div>

                {/* Section 5: Photo Evidence (Conditional) */}
                {requiresPhoto && (
                    <div className="space-y-4 p-4 border border-red-400 rounded-xl bg-red-50">
                        <h2 className="text-xl font-bold text-red-800 flex items-center">
                            <Camera className="w-5 h-5 mr-2" /> 5. Evidencia Fotográfica (Obligatoria)
                        </h2>
                        <p className="text-sm text-red-700">
                            Motivo: <span className="font-semibold">{reasonLabel}</span>. Por favor, adjunte una fotografía clara del uniforme o zapato dañado/desgastado.
                        </p>
                        <div className="flex items-center space-x-4">
                            <input
                                type="file"
                                id="photo-input"
                                accept="image/*"
                                onChange={handlePhotoCapture}
                                className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-white focus:outline-none file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-sky-50 file:text-sky-700 hover:file:bg-sky-100"
                            />
                            {formData.photoFile && (
                                <CheckCircle className="w-6 h-6 text-green-500" title="Foto cargada" />
                            )}
                            {!formData.photoFile && (
                                <Upload className="w-6 h-6 text-gray-400" title="Pendiente de carga" />
                            )}
                        </div>
                    </div>
                )}
                
                {/* Submit Button */}
                <button
                    type="submit"
                    disabled={isSubmitting || !isAuthReady}
                    className="w-full flex items-center justify-center py-4 px-4 border border-transparent rounded-xl shadow-lg text-lg font-bold text-white bg-sky-600 hover:bg-sky-700 transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed transform hover:scale-[1.01]"
                >
                    {isSubmitting ? (
                        <Loader className="w-6 h-6 animate-spin mr-2" />
                    ) : (
                        <Clipboard className="w-6 h-6 mr-2" />
                    )}
                    {isSubmitting ? 'Enviando Solicitud...' : 'Enviar Solicitud de Uniforme'}
                </button>
                <p className="text-xs text-gray-500 text-center mt-4">
                    Toda la información es guardada en tiempo real en la base de datos Firestore.
                </p>
              </form>
          )}
      </div>
    </div>
  );
}


