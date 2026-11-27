type Light = 'low' | 'medium' | 'bright';
type Care = 'very_easy' | 'easy' | 'moderate';

export interface Plant {
  id: string;
  name: string;
  botanical: string;
  light: Light[];
  care: Care;
  water: string;
  /** Cats and dogs, per ASPCA's toxic and non-toxic plant lists. Always check the list for your exact plant. */
  petSafe: boolean;
  petNote: string;
  why: string;
}

const TOXIC = 'Can irritate or upset the stomach of cats and dogs if chewed. Keep out of reach.';
const SAFE =
  'Listed as non-toxic to cats and dogs by the ASPCA. Chewing can still cause a mild upset stomach.';

/**
 * Curated, deliberately small. None of these is described as cleaning the air: in real rooms houseplants
 * change indoor air quality very little. They are here for greenery, mood and easy care.
 */
export const PLANTS: readonly Plant[] = [
  {
    id: 'spider-plant',
    name: 'Spider plant',
    botanical: 'Chlorophytum comosum',
    light: ['medium', 'bright'],
    care: 'very_easy',
    water: 'When the top few centimetres of soil are dry.',
    petSafe: true,
    petNote: SAFE,
    why: 'Forgiving, grows fast and drops baby plants you can pot up and share.',
  },
  {
    id: 'parlor-palm',
    name: 'Parlor palm',
    botanical: 'Chamaedorea elegans',
    light: ['low', 'medium'],
    care: 'easy',
    water: 'Keep soil lightly moist, never soggy.',
    petSafe: true,
    petNote: SAFE,
    why: 'Soft, tropical look that copes with dimmer rooms.',
  },
  {
    id: 'areca-palm',
    name: 'Areca palm',
    botanical: 'Dypsis lutescens',
    light: ['bright'],
    care: 'moderate',
    water: 'Water when the top soil dries; likes some humidity.',
    petSafe: true,
    petNote: SAFE,
    why: 'Tall, feathery statement plant for a bright corner.',
  },
  {
    id: 'boston-fern',
    name: 'Boston fern',
    botanical: 'Nephrolepis exaltata',
    light: ['medium'],
    care: 'moderate',
    water: 'Keep evenly moist and mist or group with other plants.',
    petSafe: true,
    petNote: SAFE,
    why: 'Lush hanging fronds; best in a humid bathroom or kitchen.',
  },
  {
    id: 'calathea',
    name: 'Calathea',
    botanical: 'Goeppertia / Calathea',
    light: ['low', 'medium'],
    care: 'moderate',
    water: 'Evenly moist with filtered or settled water; dislikes dry air.',
    petSafe: true,
    petNote: SAFE,
    why: 'Patterned leaves that fold up at night.',
  },
  {
    id: 'snake-plant',
    name: 'Snake plant',
    botanical: 'Dracaena trifasciata',
    light: ['low', 'medium', 'bright'],
    care: 'very_easy',
    water: 'Every 2 to 3 weeks; let it dry out fully.',
    petSafe: false,
    petNote: TOXIC,
    why: 'Nearly unkillable and fine in dim corners.',
  },
  {
    id: 'zz-plant',
    name: 'ZZ plant',
    botanical: 'Zamioculcas zamiifolia',
    light: ['low', 'medium'],
    care: 'very_easy',
    water: 'Every 2 to 4 weeks; stores water in its roots.',
    petSafe: false,
    petNote: TOXIC,
    why: 'Glossy and tolerant of neglect and low light.',
  },
  {
    id: 'pothos',
    name: 'Pothos',
    botanical: 'Epipremnum aureum',
    light: ['low', 'medium'],
    care: 'very_easy',
    water: 'When the top soil is dry; droops when thirsty.',
    petSafe: false,
    petNote: TOXIC,
    why: 'Trails from a shelf and roots easily from cuttings.',
  },
  {
    id: 'peace-lily',
    name: 'Peace lily',
    botanical: 'Spathiphyllum',
    light: ['low', 'medium'],
    care: 'easy',
    water: 'Droops clearly when it needs water; keep soil lightly moist.',
    petSafe: false,
    petNote: TOXIC,
    why: 'Handsome white flowers even in modest light.',
  },
];

export const PLANT_FACTS = PLANTS.map(
  (p) =>
    `${p.name} (${p.botanical}): light ${p.light.join('/')}, care ${p.care}, ${p.petSafe ? 'non-toxic' : 'TOXIC'} to cats and dogs.`,
).join('\n');
