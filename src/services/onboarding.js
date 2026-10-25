import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, createTask, today, inferExecutionPriorityAndPillar } from '../db/index.js';
import { rememberMemory, getActiveMemories } from '../context/memory-store.js';
import { executeCompanionTool } from '../agent/tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

export const STANDARD_ONBOARDING_QUESTIONS = [
  {
    step: 1,
    sectionId: 'identity',
    sectionTitle: '👤 Who You Are & How We Talk',
    sectionSubtitle: 'Seeds your Companion’s identity awareness and executive-function coaching style.',
    questions: [
      {
        id: 'fullName',
        number: 1,
        question: 'What is your name, and what should your Companion call you?',
        placeholder: 'e.g., Kevin Rusch (call me Kevin)',
        targetTable: 'companion_context (key: user_identity)',
        type: 'text'
      },
      {
        id: 'commStyle',
        number: 2,
        question: 'How do you want your Companion to communicate with you?',
        placeholder: 'e.g., Direct, concise, warm, action-oriented — turn vague thoughts into clear checklists without lecturing.',
        targetTable: 'companion_context (key: executive_function_style)',
        type: 'textarea'
      },
      {
        id: 'overwhelmProtocol',
        number: 3,
        question: 'When you feel overwhelmed or have too much on your plate, what helps most?',
        placeholder: 'e.g., Pick the single most urgent task, break it into 3 small steps, and hide the rest of the backlog.',
        targetTable: 'companion_context (key: overwhelm_protocol)',
        type: 'textarea'
      }
    ]
  },
  {
    step: 2,
    sectionId: 'family',
    sectionTitle: '❤️ Partner, Family & Household',
    sectionSubtitle: 'Seeds your Personal CRM (companion_contacts) and relationship invariants so you never have to explain who people are.',
    questions: [
      {
        id: 'partnerName',
        number: 4,
        question: 'What is your spouse or partner’s name?',
        placeholder: 'e.g., Alex',
        targetTable: 'companion_contacts + companion_context (key: partner_wife)',
        type: 'text'
      },
      {
        id: 'partnerWorkplace',
        number: 5,
        question: 'Where does your partner work or go regularly (name & address)?',
        placeholder: 'e.g., Springfield High School, 100 Maple Avenue, Springfield, OR 97477',
        targetTable: 'companion_contacts + companion_context (key: partner_wife)',
        type: 'text'
      },
      {
        id: 'partnerPickupTime',
        number: 6,
        question: 'Is there a regular pickup, drop-off, or check-in time for your partner?',
        placeholder: 'e.g., Pick up Alex at 3:30 PM on weekdays',
        targetTable: 'companion_context (key: partner_wife)',
        type: 'text'
      },
      {
        id: 'householdMembers',
        number: 7,
        question: 'Who else is in your household, immediate family, or pets? (One per line: Name — Relationship — Notes)',
        placeholder: 'e.g., Kids, parents, or pets — one per line',
        targetTable: 'companion_contacts + companion_context (key: household_members)',
        type: 'textarea'
      },
      {
        id: 'importantDates',
        number: 8,
        question: 'What are the key birthdays, anniversaries, or family dates to remember?',
        placeholder: 'e.g., Anniversary, Alex’s birthday',
        targetTable: 'companion_contacts + companion_context (key: important_dates)',
        type: 'text'
      }
    ]
  },
  {
    step: 3,
    sectionId: 'locations',
    sectionTitle: '📍 Home, Locations & Commute Defaults',
    sectionSubtitle: 'Used automatically for turn-by-turn driving directions, OSRM/Maps routing, and Time-to-Leave alerts.',
    questions: [
      {
        id: 'homeAddress',
        number: 9,
        question: 'What is your Home Address? (Used as your default starting location for directions)',
        placeholder: 'e.g., 742 Evergreen Terrace, Springfield, OR 97477',
        targetTable: 'companion_context (key: home_location)',
        type: 'text'
      },
      {
        id: 'workAddress',
        number: 10,
        question: 'What is your Work / Office Address (or Home Office)?',
        placeholder: 'e.g., Home Office — 742 Evergreen Terrace, Springfield, OR 97477',
        targetTable: 'companion_context (key: work_location)',
        type: 'text'
      },
      {
        id: 'frequentPlaces',
        number: 11,
        question: 'What are your frequent destinations (schools, stores, church, gym)? (One per line)',
        placeholder: 'e.g., Springfield High School — 100 Maple Avenue, Springfield, OR 97477\nLocal Hardware Store',
        targetTable: 'companion_context (key: saved_places)',
        type: 'textarea'
      },
      {
        id: 'commuteBufferMinutes',
        number: 12,
        question: 'How many minutes of arrival buffer do you want on commute & pickup alerts?',
        placeholder: '10',
        targetTable: 'companion_context (key: commute_buffer_minutes)',
        type: 'text'
      }
    ]
  },
  {
    step: 4,
    sectionId: 'work',
    sectionTitle: '💼 Work, Role & Daily Rhythm',
    sectionSubtitle: 'Helps your Companion prioritize urgent deadlines vs. deep work and family boundaries.',
    questions: [
      {
        id: 'workRole',
        number: 13,
        question: 'What is your job, role, or main focus right now?',
        placeholder: 'e.g., Systems Architect & AI Engineer managing Sovereign AI applications',
        targetTable: 'companion_context (key: work_profile)',
        type: 'textarea'
      },
      {
        id: 'dailyRhythm',
        number: 14,
        question: 'What are your typical work hours and protected family time windows?',
        placeholder: 'e.g., Deep work 8:30 AM – 3:00 PM; 3:15 PM – 4:00 PM school pickup run; evenings reserved for family',
        targetTable: 'companion_context (key: daily_rhythm)',
        type: 'textarea'
      }
    ]
  },
  {
    step: 5,
    sectionId: 'routines_voice',
    sectionTitle: '🔁 Daily Habits & Voice Recognition Vocabulary',
    sectionSubtitle: 'Seeds your recurring daily habits on Today’s Board and biases Faster-Whisper STT toward your real names & streets.',
    questions: [
      {
        id: 'dailyHabits',
        number: 15,
        question: 'What recurring daily habits should appear on Today’s Board every morning? (One per line)',
        placeholder: 'Morning gratitude & prayer\nCheck in with partner\nHydrate & morning movement\nReview top priority for today',
        targetTable: 'tasks (recurring = 1, execution_priority = 3)',
        type: 'textarea'
      },
      {
        id: 'customVocabulary',
        number: 16,
        question: 'What names, street names, or words should Voice Dictation (Whisper STT) always recognize?',
        placeholder: 'Alex, Evergreen Terrace, Maple Avenue, Krusch Companion, Today\'s Board, checklist, priority',
        targetTable: 'data/whisper-prompt.txt + companion_context (key: whisper_vocabulary)',
        type: 'textarea'
      }
    ]
  }
];

export const DEFAULT_ONBOARDING_PROFILE = {
  fullName: 'Krusch User',
  commStyle: 'Direct, concise, warm, action-oriented — turn spoken intentions into clear tasks and checklists without lecturing.',
  overwhelmProtocol: 'Pick the single highest-priority task, break it into 3 small actionable steps, and keep the board uncluttered.',
  partnerName: '',
  partnerWorkplace: '',
  partnerPickupTime: '',
  householdMembers: '',
  importantDates: '',
  homeAddress: '',
  workAddress: '',
  frequentPlaces: '',
  commuteBufferMinutes: '10',
  workRole: 'Systems Architect & AI Engineer building Sovereign AI applications',
  dailyRhythm: 'Morning & early afternoon deep work; late afternoon family logistics; evenings with family',
  dailyHabits: 'Morning gratitude & prayer\nCheck in with family\nHydrate & morning movement\nReview top priority for today',
  customVocabulary: 'Krusch Companion, Today\'s Board, checklist, priority, commute, groceries, dishes'
};

export function getOnboardingState() {
  const database = getDb();
  const completedRow = database.prepare('SELECT value FROM config WHERE key = ?').get('onboarding_completed');
  const skippedRow = database.prepare('SELECT value FROM config WHERE key = ?').get('onboarding_skipped_at');
  const profileRow = database.prepare('SELECT value FROM config WHERE key = ?').get('onboarding_profile_json');

  let savedProfile = {};
  if (profileRow?.value) {
    try {
      savedProfile = JSON.parse(profileRow.value);
    } catch {
      savedProfile = {};
    }
  }

  const profile = {
    ...DEFAULT_ONBOARDING_PROFILE,
    ...savedProfile
  };

  return {
    completed: completedRow?.value === '1',
    skippedAt: skippedRow?.value || null,
    profile,
    sections: STANDARD_ONBOARDING_QUESTIONS
  };
}

export function skipOnboarding() {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('onboarding_completed', '1');
  database.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('onboarding_skipped_at', now);
  return {
    ok: true,
    completed: true,
    skippedAt: now
  };
}

export async function saveOnboardingProfile(inputProfile = {}) {
  const database = getDb();
  const merged = {
    ...DEFAULT_ONBOARDING_PROFILE,
    ...Object.fromEntries(
      Object.entries(inputProfile || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
    )
  };

  const seededMemories = [];
  const seededContacts = [];
  const seededHabits = [];

  // 1. Identity & Communication Style
  if (merged.fullName) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'user_identity',
        content: `User identity: ${merged.fullName}.`
      })
    );
  }
  if (merged.commStyle) {
    seededMemories.push(
      rememberMemory({
        category: 'decision',
        key: 'executive_function_style',
        content: `Preferred communication & coaching style: ${merged.commStyle}`
      })
    );
  }
  if (merged.overwhelmProtocol) {
    seededMemories.push(
      rememberMemory({
        category: 'decision',
        key: 'overwhelm_protocol',
        content: `Overwhelm & focus protocol: ${merged.overwhelmProtocol}`
      })
    );
  }

  // 2. Partner & Family
  if (merged.partnerName) {
    const partnerDetails = [
      `User's wife/partner is ${merged.partnerName}.`,
      merged.partnerWorkplace ? `She works/goes to ${merged.partnerWorkplace}.` : '',
      merged.partnerPickupTime ? `Regular pickup/schedule: ${merged.partnerPickupTime}.` : ''
    ]
      .filter(Boolean)
      .join(' ');

    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'partner_wife',
        content: partnerDetails
      })
    );

    try {
      const crmRes = await executeCompanionTool('personal_crm_profile', {
        action: 'upsert_contact',
        name: merged.partnerName,
        relationship: 'wife / partner',
        importantDates: merged.importantDates || '',
        notes: [
          merged.partnerWorkplace ? `Workplace: ${merged.partnerWorkplace}` : '',
          merged.partnerPickupTime ? `Pickup/Schedule: ${merged.partnerPickupTime}` : ''
        ]
          .filter(Boolean)
          .join(' | ')
      });
      if (crmRes?.data?.contact) seededContacts.push(crmRes.data.contact);
    } catch (err) {
      if (process.env.KRUSCH_DEBUG === '1') {
        console.debug(`[Onboarding:partnerCrm] ${err.message}`);
      }
    }
  }

  if (merged.householdMembers) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'household_members',
        content: `Household & immediate family members: ${merged.householdMembers.replace(/\n+/g, '; ')}`
      })
    );

    const lines = String(merged.householdMembers)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s*(?:—|--|-|:)\s*/);
      const name = (parts[0] || '').trim();
      const relationship = (parts[1] || 'family').trim();
      const notes = parts.slice(2).join(' — ').trim();
      if (name) {
        try {
          const cRes = await executeCompanionTool('personal_crm_profile', {
            action: 'upsert_contact',
            name,
            relationship,
            notes
          });
          if (cRes?.data?.contact) seededContacts.push(cRes.data.contact);
        } catch (err) {
          if (process.env.KRUSCH_DEBUG === '1') {
            console.debug(`[Onboarding:householdCrm] ${err.message}`);
          }
        }
      }
    }
  }

  if (merged.importantDates) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'important_dates',
        content: `Important family dates & anniversaries: ${merged.importantDates}`
      })
    );
  }

  // 3. Locations & Commute Defaults
  if (merged.homeAddress) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'home_location',
        content: `Home address is ${merged.homeAddress} (default starting origin for commute & driving directions).`
      })
    );
  }
  if (merged.workAddress) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'work_location',
        content: `Work / office location: ${merged.workAddress}`
      })
    );
  }
  if (merged.frequentPlaces) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'saved_places',
        content: `Frequent destinations & saved places: ${merged.frequentPlaces.replace(/\n+/g, '; ')}`
      })
    );
  }
  if (merged.commuteBufferMinutes) {
    seededMemories.push(
      rememberMemory({
        category: 'decision',
        key: 'commute_buffer_minutes',
        content: `Default commute arrival buffer is ${merged.commuteBufferMinutes} minutes.`
      })
    );
  }

  // 4. Work & Daily Rhythm
  if (merged.workRole) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'work_profile',
        content: `Work & role profile: ${merged.workRole}`
      })
    );
  }
  if (merged.dailyRhythm) {
    seededMemories.push(
      rememberMemory({
        category: 'decision',
        key: 'daily_rhythm',
        content: `Daily schedule & protected time windows: ${merged.dailyRhythm}`
      })
    );
  }

  // 5. Recurring Daily Habits -> Tasks Table
  if (merged.dailyHabits) {
    const habitLines = String(merged.dailyHabits)
      .split(/\r?\n/)
      .map(l => l.replace(/^[-*•\d.)\s]+/, '').trim())
      .filter(Boolean);
    const todayStr = today();
    const existingRows = database
      .prepare('SELECT lower(trim(title)) as norm_title FROM tasks WHERE date = ?')
      .all(todayStr)
      .map(r => r.norm_title);
    const existingSet = new Set(existingRows);

    for (const habitTitle of habitLines) {
      const norm = habitTitle.toLowerCase();
      if (!existingSet.has(norm)) {
        const inferred = inferExecutionPriorityAndPillar({ title: habitTitle, recurring: 1 });
        const created = createTask({
          title: habitTitle,
          priority_id: inferred.priority_id || 4,
          execution_priority: 3,
          pillar: inferred.pillar,
          recurring: 1,
          date: todayStr
        });
        existingSet.add(norm);
        seededHabits.push(created);
      }
    }
  }

  // 6. Custom Whisper STT Vocabulary -> companion_context + data/whisper-prompt.txt
  const vocabParts = [
    merged.customVocabulary,
    merged.fullName,
    merged.partnerName ? `${merged.partnerName}, my wife ${merged.partnerName}` : '',
    merged.partnerWorkplace,
    merged.homeAddress
  ]
    .filter(Boolean)
    .join(', ');

  if (vocabParts) {
    seededMemories.push(
      rememberMemory({
        category: 'invariant',
        key: 'whisper_vocabulary',
        content: `Voice recognition vocabulary & proper nouns: ${vocabParts}`
      })
    );
    try {
      const dataDir = path.join(projectRoot, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'whisper-prompt.txt'), `${vocabParts}.`, 'utf-8');
    } catch (err) {
      if (process.env.KRUSCH_DEBUG === '1') {
        console.debug(`[Onboarding:whisperPrompt] ${err.message}`);
      }
    }
  }

  // Save onboarding status & profile JSON in SQLite config table
  database
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('onboarding_profile_json', JSON.stringify(merged));
  database
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('onboarding_completed', '1');

  return {
    ok: true,
    completed: true,
    profile: merged,
    seededSummary: {
      memoriesCount: seededMemories.length,
      contactsCount: seededContacts.length,
      habitsCount: seededHabits.length,
      whisperPromptUpdated: Boolean(vocabParts),
      activeMemoriesTotal: getActiveMemories().length
    }
  };
}
