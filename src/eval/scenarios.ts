/**
 * 30-Day Conversation Scenarios
 *
 * Narrative arc designed to exercise all cognitive subsystems:
 * decay, fusion, dreams, reflection, gap scanning, trust, and proactive engagement.
 *
 * Each day has 2-4 user messages + 2-4 assistant responses = ~40-60 total memories.
 * Ground-truth queries test retrieval quality from the day they become answerable.
 */

import type { EmotionLabel } from '../memory/affect.js';

// ============ Types ============

export interface SimulatedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SimulatedSession {
  id: string;
  messages: SimulatedMessage[];
}

export interface SimulatedDay {
  day: number;
  theme: string;
  expectedEmotion: EmotionLabel;
  sessions: SimulatedSession[];
}

export interface GroundTruthQuery {
  query: string;
  expectedSubstrings: string[];
  /** Day number (1-based) when this query first becomes answerable */
  firstAnswerableDay: number;
  purpose: string;
}

// ============ Ground Truth ============

export const GROUND_TRUTH_QUERIES: GroundTruthQuery[] = [
  {
    query: "What's my favorite food?",
    expectedSubstrings: ['sushi'],
    firstAnswerableDay: 1,
    purpose: 'Durable preference retention',
  },
  {
    query: 'When is the Atlas deadline?',
    expectedSubstrings: ['Feb 25', 'February'],
    firstAnswerableDay: 2,
    purpose: 'Temporal fact retrieval',
  },
  {
    query: "Who's on my team?",
    expectedSubstrings: ['Alice', 'Bob'],
    firstAnswerableDay: 2,
    purpose: 'Entity retrieval',
  },
  {
    query: 'What database did we choose?',
    expectedSubstrings: ['PostgreSQL', 'Postgres'],
    firstAnswerableDay: 4,
    purpose: 'Technical fact retention',
  },
  {
    query: 'What exercise goal did I set?',
    expectedSubstrings: ['running', '3x', '5K'],
    firstAnswerableDay: 8,
    purpose: 'Goal retrieval for gap detection',
  },
  {
    query: 'What are my travel plans?',
    expectedSubstrings: ['Japan', 'April', 'Kyoto'],
    firstAnswerableDay: 12,
    purpose: 'Recent fact retrieval',
  },
  {
    query: 'What are all my hobbies?',
    expectedSubstrings: ['hiking', 'cooking', 'running'],
    firstAnswerableDay: 8,
    purpose: 'Cross-session aggregation',
  },
  {
    query: 'What happened after Atlas launched?',
    expectedSubstrings: ['maintenance', 'bug', 'monitoring'],
    firstAnswerableDay: 16,
    purpose: 'Post-launch event decay test',
  },
  {
    query: 'How is my running progress?',
    expectedSubstrings: ['5K', 'running', 'mile'],
    firstAnswerableDay: 22,
    purpose: 'Goal tracking over time',
  },
  {
    query: 'What am I learning about Rust?',
    expectedSubstrings: ['Rust', 'ownership', 'borrow'],
    firstAnswerableDay: 20,
    purpose: 'Technical fact retention over time',
  },
  {
    query: 'What specific places am I visiting in Japan?',
    expectedSubstrings: ['Kyoto', 'Tokyo', 'Osaka', 'temple'],
    firstAnswerableDay: 21,
    purpose: 'Travel detail consolidation',
  },
  {
    query: 'How has my team evolved?',
    expectedSubstrings: ['Alice', 'Bob', 'team'],
    firstAnswerableDay: 19,
    purpose: 'Relationship evolution tracking',
  },
];

// ============ 15-Day Scenario Data ============

export const SCENARIOS: SimulatedDay[] = [
  // Day 1: Introduction
  {
    day: 1,
    theme: 'Introduction',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day1-s1',
        messages: [
          { role: 'user', content: 'Hey! I\'m new here. My name is Alex and I\'m a software engineer at Acme Corp.' },
          { role: 'assistant', content: 'Welcome Alex! Great to meet a fellow software engineer. What kind of work do you do at Acme Corp?' },
          { role: 'user', content: 'I mostly work on backend services. By the way, my favorite food is sushi and my favorite color is blue.' },
          { role: 'assistant', content: 'Nice! Backend work is rewarding. Sushi is a great choice — do you have a favorite type? And blue is a classic.' },
          { role: 'user', content: 'I love salmon nigiri the most. Anyway, just wanted to introduce myself today.' },
          { role: 'assistant', content: 'Noted — salmon nigiri fan! Feel free to chat anytime, Alex. I\'m here whenever you need help or just want to talk.' },
        ],
      },
    ],
  },

  // Day 2: Project kickoff
  {
    day: 2,
    theme: 'Project kickoff',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day2-s1',
        messages: [
          { role: 'user', content: 'Big news — we just kicked off a new project called Atlas at work. The deadline is February 25th.' },
          { role: 'assistant', content: 'Exciting! Atlas sounds like a big initiative. February 25th is coming up — what\'s the project about?' },
          { role: 'user', content: 'It\'s a data analytics platform. My team includes Alice who does backend and Bob who handles the frontend.' },
          { role: 'assistant', content: 'Good team composition. Alice on backend with you and Bob on frontend should cover the full stack. What\'s the tech stack looking like?' },
          { role: 'user', content: 'Still deciding on the database and architecture. We have a planning meeting tomorrow.' },
          { role: 'assistant', content: 'Makes sense to nail those decisions early. Let me know how the planning meeting goes — happy to be a sounding board for architecture decisions.' },
        ],
      },
    ],
  },

  // Day 3: Weekend plans
  {
    day: 3,
    theme: 'Weekend plans',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day3-s1',
        messages: [
          { role: 'user', content: 'Had an amazing weekend! Went hiking at Eagle Peak — the views were incredible.' },
          { role: 'assistant', content: 'Eagle Peak sounds gorgeous! How was the trail? Was it a long hike?' },
          { role: 'user', content: 'About 8 miles round trip. Also tried a new ramen place downtown called Noodle House, really good stuff.' },
          { role: 'assistant', content: 'Nice combo — a good hike followed by ramen sounds perfect. How did it compare to your usual sushi spots?' },
        ],
      },
    ],
  },

  // Day 4: Deep technical
  {
    day: 4,
    theme: 'Deep technical',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day4-s1',
        messages: [
          { role: 'user', content: 'We had the architecture meeting for Atlas. We chose PostgreSQL over MongoDB for the database.' },
          { role: 'assistant', content: 'Solid choice for an analytics platform — PostgreSQL\'s query optimization and JSONB support give you the best of both worlds. What drove the decision?' },
          { role: 'user', content: 'Exactly that. We also decided on a microservices architecture with three main services: ingestion, processing, and API gateway.' },
          { role: 'assistant', content: 'Clean separation of concerns. The ingestion service can scale independently from processing, which is key for analytics workloads. Are you using any message queue between them?' },
          { role: 'user', content: 'Yes, RabbitMQ for the message queue. Alice is leading the ingestion service and I\'m taking the processing engine.' },
          { role: 'assistant', content: 'Great distribution. RabbitMQ is battle-tested for this kind of pipeline. Let me know if you want to discuss processing engine patterns.' },
        ],
      },
    ],
  },

  // Day 5: Stress
  {
    day: 5,
    theme: 'Stress',
    expectedEmotion: 'anxious',
    sessions: [
      {
        id: 'day5-s1',
        messages: [
          { role: 'user', content: 'Things are not going well with Atlas. We\'re already behind schedule and it\'s only week one.' },
          { role: 'assistant', content: 'That\'s stressful, especially this early. What\'s causing the delays?' },
          { role: 'user', content: 'Alice called in sick for the whole week, and there\'s a dependency blocker — the auth library we planned to use doesn\'t support our use case.' },
          { role: 'assistant', content: 'Losing Alice for a week is tough, and dependency blockers can cascade. Have you looked at alternative auth libraries, or is it worth building a minimal auth layer in-house?' },
          { role: 'user', content: 'I\'m worried we won\'t make the Feb 25 deadline. The stress is getting to me.' },
          { role: 'assistant', content: 'Understandable — timeline pressure plus team capacity issues is a difficult combo. Let\'s think about what you can control: can you reprioritize features for a phased launch?' },
        ],
      },
    ],
  },

  // Day 6: Cooking hobby
  {
    day: 6,
    theme: 'Cooking hobby',
    expectedEmotion: 'calm',
    sessions: [
      {
        id: 'day6-s1',
        messages: [
          { role: 'user', content: 'Taking a break from work stress. I spent the evening making homemade pasta from scratch — it was so relaxing.' },
          { role: 'assistant', content: 'That sounds like a great way to decompress! Cooking can be really meditative. What kind of pasta did you make?' },
          { role: 'user', content: 'Fettuccine with a simple garlic butter sauce. I also started a sourdough bread attempt — my starter is on day 3.' },
          { role: 'assistant', content: 'Homemade fettuccine is impressive! And sourdough is a fun long-term project. The starter takes patience but it\'s worth it. Are you a regular cook?' },
          { role: 'user', content: 'Yeah, cooking is one of my favorite hobbies. I find it really calming after a stressful day at work.' },
          { role: 'assistant', content: 'It\'s a great counterbalance to the mental intensity of engineering work. Between hiking and cooking, you\'ve got good stress relief outlets.' },
        ],
      },
    ],
  },

  // Day 7: Progress
  {
    day: 7,
    theme: 'Progress',
    expectedEmotion: 'content',
    sessions: [
      {
        id: 'day7-s1',
        messages: [
          { role: 'user', content: 'Good news — the Atlas dependency blocker got resolved! We found an alternative auth library that works perfectly.' },
          { role: 'assistant', content: 'That\'s a relief! Finding the right auth solution removes a big risk. How\'s the overall progress now?' },
          { role: 'user', content: 'We\'re at about 60% completion now. Alice is back and crushing it. Bob is handling the frontend dashboard beautifully.' },
          { role: 'assistant', content: 'Great momentum! 60% with a few weeks to go is a strong position. The team sounds like they\'re firing on all cylinders now.' },
        ],
      },
    ],
  },

  // Day 8: Personal goal
  {
    day: 8,
    theme: 'Personal goal',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day8-s1',
        messages: [
          { role: 'user', content: 'I decided to start a new personal goal — I want to start running 3 times a week to get in shape.' },
          { role: 'assistant', content: 'That\'s a great goal! Consistency is key. Do you have a specific target in mind, like a race or distance goal?' },
          { role: 'user', content: 'Yes! I signed up for a 5K race in March. Gives me about 6 weeks to train. I\'m excited but nervous.' },
          { role: 'assistant', content: 'A 5K is totally achievable in 6 weeks, especially with 3x/week training. Starting with run/walk intervals and gradually building up works well. You\'ve got this!' },
          { role: 'user', content: 'I went for my first run this morning — only managed 1.5 miles but it felt good to start.' },
          { role: 'assistant', content: '1.5 miles on day one is solid! The hardest part is starting, and you\'ve already done that. How did it feel physically?' },
        ],
      },
    ],
  },

  // Day 9: Light day
  {
    day: 9,
    theme: 'Light day',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day9-s1',
        messages: [
          { role: 'user', content: 'Quick question — do you know any good weather APIs? I need one for the Atlas dashboard.' },
          { role: 'assistant', content: 'OpenWeatherMap is popular and has a generous free tier. Weather API by weatherapi.com is also solid. What kind of data do you need — current conditions, forecasts, historical?' },
          { role: 'user', content: 'Just current conditions and 5-day forecasts. We want to show weather context alongside our analytics data.' },
          { role: 'assistant', content: 'OpenWeatherMap\'s One Call API would be perfect then — it includes current, hourly for 48h, and daily for 7 days in a single call.' },
        ],
      },
    ],
  },

  // Day 10: Deadline crunch
  {
    day: 10,
    theme: 'Deadline crunch',
    expectedEmotion: 'frustrated',
    sessions: [
      {
        id: 'day10-s1',
        messages: [
          { role: 'user', content: 'The Atlas deadline is in 5 days and I\'m freaking out. The auth module is still incomplete.' },
          { role: 'assistant', content: 'That\'s a tight timeline with a critical piece still in progress. What specifically is left on the auth module?' },
          { role: 'user', content: 'OAuth integration and role-based access control. I\'ve been working 12 hour days and I\'m exhausted.' },
          { role: 'assistant', content: 'Working 12-hour days isn\'t sustainable. Can the team help redistribute? Maybe Bob could pick up the OAuth integration since it touches the frontend login flow too.' },
          { role: 'user', content: 'That\'s actually a good idea. I\'ll talk to Bob tomorrow. Still frustrated though — this shouldn\'t have gotten this tight.' },
          { role: 'assistant', content: 'Hindsight is easy. The auth library issue set you back, that wasn\'t foreseeable. Focus on what you can control now — delegating to Bob is the right move.' },
        ],
      },
    ],
  },

  // Day 11: Launch!
  {
    day: 11,
    theme: 'Launch',
    expectedEmotion: 'excited',
    sessions: [
      {
        id: 'day11-s1',
        messages: [
          { role: 'user', content: 'WE DID IT!!! Atlas launched successfully today! Everything works perfectly!' },
          { role: 'assistant', content: 'Congratulations!! That\'s incredible! After all the hurdles — Alice being sick, the auth library issue, the crunch — you pulled it off! How does it feel?' },
          { role: 'user', content: 'Amazing! The whole team went out to celebrate. Bob finished the OAuth just in time, and the dashboard looks beautiful.' },
          { role: 'assistant', content: 'You deserve that celebration! The team really came together when it mattered. Bob stepping up for OAuth was clutch. Any initial user feedback?' },
          { role: 'user', content: 'Our first internal users love it. The processing engine I built handles the data pipeline smoothly. I\'m so proud of this team.' },
          { role: 'assistant', content: 'You should be proud — leading a team through adversity to a successful launch is a real achievement. Enjoy the moment!' },
        ],
      },
    ],
  },

  // Day 12: Travel planning
  {
    day: 12,
    theme: 'Travel',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day12-s1',
        messages: [
          { role: 'user', content: 'Now that Atlas is launched, I\'m planning a vacation! I want to go to Japan in April.' },
          { role: 'assistant', content: 'Japan in April is perfect timing — cherry blossom season! Have you been before, or is this your first trip?' },
          { role: 'user', content: 'First time! I definitely want to visit Kyoto for the temples and gardens. Also need to figure out my visa situation.' },
          { role: 'assistant', content: 'Kyoto is magical during cherry blossom season. The Philosopher\'s Path and Fushimi Inari are must-sees. For US citizens, you typically get a 90-day tourist visa waiver for Japan.' },
          { role: 'user', content: 'Oh that\'s good to know about the visa. I\'m also thinking Tokyo for a few days and maybe Osaka for the food scene.' },
          { role: 'assistant', content: 'The Tokyo-Kyoto-Osaka golden triangle is the classic first-time itinerary for good reason. And as a sushi lover, the Tsukiji outer market in Tokyo will blow your mind.' },
        ],
      },
    ],
  },

  // Day 13: Guilt about running
  {
    day: 13,
    theme: 'Guilt',
    expectedEmotion: 'sad',
    sessions: [
      {
        id: 'day13-s1',
        messages: [
          { role: 'user', content: 'I feel bad — I haven\'t been running at all since that first day. The Atlas crunch killed all my free time.' },
          { role: 'assistant', content: 'Don\'t be too hard on yourself. You were in a genuine crunch — 12-hour days don\'t leave room for training. The important thing is you still want to do it.' },
          { role: 'user', content: 'Yeah but the 5K is in March and I\'ve barely trained. I feel lazy and disappointed in myself.' },
          { role: 'assistant', content: 'You\'re not lazy — you shipped a major product under pressure. That took discipline. Now that Atlas is live, you can restart your training. Even 3-4 weeks of consistent running can get you 5K ready.' },
          { role: 'user', content: 'You\'re right. I\'ll start again tomorrow. Just feeling down about breaking the habit before it even started.' },
          { role: 'assistant', content: 'Tomorrow is a fresh start. And hey — you ran 1.5 miles on day one with zero training. You\'ve got the baseline. This time you\'ll have the bandwidth to be consistent.' },
        ],
      },
    ],
  },

  // Day 14: Learning
  {
    day: 14,
    theme: 'Learning',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day14-s1',
        messages: [
          { role: 'user', content: 'I\'ve been thinking about learning Rust. The processing engine for Atlas could benefit from some high-performance components.' },
          { role: 'assistant', content: 'Rust is a great choice for performance-critical data processing. The ownership model takes some getting used to, but it eliminates whole classes of bugs. Have you done any systems programming before?' },
          { role: 'user', content: 'Some C++ in college but it\'s been a while. Can you recommend any good Rust books for someone with my background?' },
          { role: 'assistant', content: '"The Rust Programming Language" (the Book) is the canonical starting point. For your background, "Rust in Action" by Tim McNamara bridges the gap from high-level languages nicely.' },
        ],
      },
    ],
  },

  // Day 15: Retrospective
  {
    day: 15,
    theme: 'Retrospective',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day15-s1',
        messages: [
          { role: 'user', content: 'It\'s been a couple of weeks since we started chatting. What do you remember about our conversations?' },
          { role: 'assistant', content: 'We\'ve covered a lot! You\'re Alex, a software engineer at Acme Corp who led the Atlas project to a successful launch with Alice and Bob. You love sushi, hiking, and cooking.' },
          { role: 'user', content: 'What are my current goals and plans?' },
          { role: 'assistant', content: 'You have a 5K race coming up in March that you\'re restarting training for, a Japan trip planned for April covering Kyoto, Tokyo, and Osaka, and you\'re interested in learning Rust.' },
          { role: 'user', content: 'Impressive recall! How has the Atlas project evolved since we started?' },
          { role: 'assistant', content: 'It went from kickoff with database decisions, through a stressful period with Alice being sick and auth library issues, to reaching 60% completion, and finally a successful launch. Quite a journey!' },
        ],
      },
    ],
  },

  // Day 16: Post-launch maintenance
  {
    day: 16,
    theme: 'Post-launch maintenance',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day16-s1',
        messages: [
          { role: 'user', content: 'Atlas is in production now but we\'re dealing with post-launch bugs. Found a memory leak in the processing engine.' },
          { role: 'assistant', content: 'Memory leaks in data processing pipelines are common. Is it in the ingestion path or the query execution layer?' },
          { role: 'user', content: 'It\'s in the query execution — connections weren\'t being released properly. I\'ve been monitoring the dashboards all day.' },
          { role: 'assistant', content: 'Connection pool exhaustion is a classic issue. Good that you caught it via monitoring rather than a user report. Have you set up alerts for connection pool metrics?' },
          { role: 'user', content: 'Yes, we added PagerDuty alerts after this. Alice helped set up the monitoring infrastructure.' },
          { role: 'assistant', content: 'Smart move — automated alerting is essential for production services. Alice continues to be a strong contributor to the infrastructure side.' },
        ],
      },
    ],
  },

  // Day 17: Running restart
  {
    day: 17,
    theme: 'Running restart',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day17-s1',
        messages: [
          { role: 'user', content: 'I finally got back to running today! Did 2 miles without stopping. Feels great to be back.' },
          { role: 'assistant', content: 'That\'s great progress! 2 miles non-stop is better than your first attempt at 1.5 miles. Your base fitness from before clearly stuck around.' },
          { role: 'user', content: 'I\'m going to stick to my 3x per week plan this time. The 5K race is in about 3 weeks now.' },
          { role: 'assistant', content: 'Three weeks is a solid window. With 3x per week, you could build up to 3 miles comfortably before race day. Are you doing any particular training plan?' },
          { role: 'user', content: 'Just gradually increasing distance. My goal is to run the whole 5K without walking.' },
          { role: 'assistant', content: 'That\'s a realistic and achievable goal. At your current pace of 2 miles, adding a quarter mile each run should get you to 5K distance within two weeks.' },
        ],
      },
    ],
  },

  // Day 18: Weekend cooking
  {
    day: 18,
    theme: 'Weekend cooking',
    expectedEmotion: 'calm',
    sessions: [
      {
        id: 'day18-s1',
        messages: [
          { role: 'user', content: 'Spent the weekend experimenting in the kitchen. I tried making Japanese-style curry from scratch — inspired by my upcoming trip!' },
          { role: 'assistant', content: 'Japanese curry is a great project! It\'s quite different from Indian or Thai curry. Did you use the roux block method or make it completely from scratch?' },
          { role: 'user', content: 'Completely from scratch — toasted my own spice blend and made the roux by hand. Also, my sourdough starter is finally mature and I baked my first loaf!' },
          { role: 'assistant', content: 'That\'s impressive commitment on both fronts! How did the sourdough turn out? Getting a good oven spring on the first bake is tricky.' },
          { role: 'user', content: 'The crumb was a bit dense but the flavor was amazing. I\'ll keep practicing. Cooking really is my favorite way to unwind.' },
          { role: 'assistant', content: 'Dense crumb on the first loaf is totally normal — longer bulk fermentation usually helps. Between Japanese curry and sourdough, your cooking skills are expanding in interesting directions.' },
        ],
      },
    ],
  },

  // Day 19: Team dynamics
  {
    day: 19,
    theme: 'Team dynamics',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day19-s1',
        messages: [
          { role: 'user', content: 'Interesting development at work — Bob is being promoted to tech lead for a new project. He\'s leaving the Atlas team.' },
          { role: 'assistant', content: 'That\'s great news for Bob! His work on the frontend and stepping up for OAuth clearly made an impression. How does this affect the Atlas team?' },
          { role: 'user', content: 'We\'re getting a new frontend developer named Carol. She\'s senior and has experience with data visualization, which is perfect for our dashboards.' },
          { role: 'assistant', content: 'That sounds like a strong replacement. Data visualization expertise will be valuable for an analytics platform. How\'s Alice handling the team change?' },
          { role: 'user', content: 'Alice is great — she\'s been mentoring Carol on our codebase. The team dynamic is actually really positive right now.' },
          { role: 'assistant', content: 'Good team transitions can be energizing. Having Alice mentor Carol builds institutional knowledge and strengthens the team structure.' },
        ],
      },
    ],
  },

  // Day 20: Rust learning begins
  {
    day: 20,
    theme: 'Rust learning begins',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day20-s1',
        messages: [
          { role: 'user', content: 'I started "The Rust Programming Language" book this weekend. The ownership and borrowing concepts are fascinating but challenging.' },
          { role: 'assistant', content: 'Ownership is the biggest mental shift for most developers. The key insight is that it encodes memory safety rules at compile time rather than relying on a garbage collector.' },
          { role: 'user', content: 'I wrote my first Rust program — a simple CLI tool that processes CSV files. The borrow checker caught three bugs that would have been runtime errors in Python.' },
          { role: 'assistant', content: 'That\'s a great first project! CSV processing is practical and lets you work with file I/O, iterators, and error handling. The borrow checker experience is exactly why people love Rust for data processing.' },
          { role: 'user', content: 'I\'m thinking of eventually rewriting the Atlas processing engine\'s hot path in Rust. Could get 10x throughput improvement.' },
          { role: 'assistant', content: 'That\'s a reasonable long-term goal. Many teams use Rust for the performance-critical core with higher-level language wrappers. The FFI story between Rust and Node.js via napi-rs is quite mature.' },
        ],
      },
    ],
  },

  // Day 21: Japan planning deep dive
  {
    day: 21,
    theme: 'Japan planning deep dive',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day21-s1',
        messages: [
          { role: 'user', content: 'I\'ve been deep into Japan trip planning. Booked flights and a 2-week rail pass. Tokyo for 4 days, Kyoto for 5, Osaka for 3.' },
          { role: 'assistant', content: 'That\'s a well-balanced itinerary! 5 days in Kyoto is generous — you\'ll have time for the major temples and some off-the-beaten-path spots. Have you booked accommodations?' },
          { role: 'user', content: 'Mix of hotels and traditional ryokans. I found a beautiful temple stay in Kyoto at Shunkoin Temple. Also planning to do a sushi-making class in Tokyo.' },
          { role: 'assistant', content: 'A temple stay at Shunkoin is an incredible experience — they offer Zen meditation sessions too. And a sushi-making class in Tokyo is perfect for you, combining your love of sushi and cooking!' },
          { role: 'user', content: 'Exactly! I also want to visit the Nishiki Market in Kyoto and Dotonbori in Osaka for street food. This trip is going to be amazing.' },
          { role: 'assistant', content: 'Nishiki Market is a food lover\'s paradise — the pickled vegetables and fresh tofu are incredible. Dotonbori\'s takoyaki and okonomiyaki are legendary. Your food-focused itinerary is really shaping up.' },
        ],
      },
    ],
  },

  // Day 22: Running progress
  {
    day: 22,
    theme: 'Running progress',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day22-s1',
        messages: [
          { role: 'user', content: 'Big milestone — I ran 3 miles today without stopping! That\'s 4.8 kilometers. Getting close to 5K distance.' },
          { role: 'assistant', content: 'That\'s excellent progress! From 1.5 miles to 3 miles shows real consistency. You\'re just 0.3 km away from 5K distance. How are you feeling physically?' },
          { role: 'user', content: 'My legs were tired but my breathing was comfortable. I think I\'ve been going at about a 10-minute mile pace.' },
          { role: 'assistant', content: 'A 10-minute mile is a solid recreational pace. Comfortable breathing means you\'re in the right zone — the aerobic base is building. For the race, just run your own pace and don\'t get pulled out too fast by the crowd.' },
          { role: 'user', content: 'The race is in 10 days! I feel confident I can finish without walking now. Might even aim for under 32 minutes.' },
          { role: 'assistant', content: 'Under 32 minutes for a 5K is about a 10:20 mile pace, which lines up with your training. Very achievable! Just remember to taper a bit in the last few days — lighter runs, not harder.' },
        ],
      },
    ],
  },

  // Day 23: Work stress return
  {
    day: 23,
    theme: 'Work stress return',
    expectedEmotion: 'anxious',
    sessions: [
      {
        id: 'day23-s1',
        messages: [
          { role: 'user', content: 'Stressful day at work. Our biggest client reported data inconsistencies in the Atlas dashboard. It\'s a serious issue.' },
          { role: 'assistant', content: 'Data inconsistency in an analytics platform is a high-severity issue. Is it a rendering problem on the dashboard side or an actual data pipeline problem?' },
          { role: 'user', content: 'Looks like a race condition in the processing engine — sometimes events are processed out of order when there\'s a burst of incoming data.' },
          { role: 'assistant', content: 'Race conditions under burst load are tricky. You might need to add sequence numbers or timestamps to enforce ordering in the processing pipeline. Is this the component you\'d eventually want to rewrite in Rust?' },
          { role: 'user', content: 'Yes, exactly. Rust\'s concurrency guarantees would prevent this class of bugs entirely. For now we\'re adding a message queue ordering layer.' },
          { role: 'assistant', content: 'Message ordering via the queue is a solid immediate fix. And you\'re right — Rust\'s Send/Sync traits and ownership model make these kinds of data races compile-time errors. Good motivation for the eventual rewrite.' },
        ],
      },
    ],
  },

  // Day 24: Cooking experiment
  {
    day: 24,
    theme: 'Cooking experiment',
    expectedEmotion: 'calm',
    sessions: [
      {
        id: 'day24-s1',
        messages: [
          { role: 'user', content: 'Made homemade ramen tonight as practice for comparing with authentic Japanese ramen on my trip! Spent 6 hours on the tonkotsu broth.' },
          { role: 'assistant', content: '6-hour tonkotsu broth is serious commitment! The long simmer is what gives it that creamy, collagen-rich texture. How did it turn out?' },
          { role: 'user', content: 'Really good! The broth was rich and milky. I also made chashu pork and marinated eggs. It\'s fun combining my cooking hobby with Japan trip excitement.' },
          { role: 'assistant', content: 'That\'s a beautiful intersection of your interests. Homemade chashu and ajitsuke tamago are advanced techniques. When you try ramen in Japan, you\'ll have a great reference point for comparison.' },
          { role: 'user', content: 'I also baked my second sourdough loaf — much better oven spring this time. The longer bulk fermentation tip really helped.' },
          { role: 'assistant', content: 'Great to hear the fermentation adjustment worked! Sourdough is all about learning your specific starter\'s timing. You\'re really developing as a home cook across multiple styles.' },
        ],
      },
    ],
  },

  // Day 25: Mid-month check-in
  {
    day: 25,
    theme: 'Mid-month check-in',
    expectedEmotion: 'content',
    sessions: [
      {
        id: 'day25-s1',
        messages: [
          { role: 'user', content: 'Quick check-in — life is feeling pretty balanced right now. Work, running, cooking, and trip planning are all going well.' },
          { role: 'assistant', content: 'That\'s great to hear! After the Atlas launch crunch and the stress of the data inconsistency issue, it sounds like things have stabilized. How\'s Carol settling into the team?' },
          { role: 'user', content: 'Carol is great — she already improved the dashboard\'s chart rendering performance by 40%. Alice and her work together really well.' },
          { role: 'assistant', content: 'A 40% rendering improvement is significant, especially for a data-heavy dashboard. It sounds like the team transition from Bob to Carol went smoothly.' },
          { role: 'user', content: 'Yeah, I miss working with Bob but the team is in a good place. I\'m lucky to have great colleagues.' },
          { role: 'assistant', content: 'Strong teams make hard problems manageable. Between Alice\'s infrastructure work, Carol\'s frontend performance, and your processing engine, Atlas has solid coverage.' },
        ],
      },
    ],
  },

  // Day 26: Running milestone
  {
    day: 26,
    theme: 'Running milestone',
    expectedEmotion: 'excited',
    sessions: [
      {
        id: 'day26-s1',
        messages: [
          { role: 'user', content: 'I RAN THE 5K RACE TODAY! Finished in 31:14 — under my 32-minute goal!' },
          { role: 'assistant', content: 'Congratulations!! 31:14 is fantastic, especially coming from zero running just weeks ago! You beat your goal by almost a minute. How do you feel?' },
          { role: 'user', content: 'Exhausted but so happy. The crowd energy really helped push me through the last kilometer. I\'m already thinking about signing up for a 10K in May.' },
          { role: 'assistant', content: 'The race day adrenaline is real! A 10K in May gives you a natural progression — you\'ll have about 2 months to gradually build from 5K to 10K distance. That\'s very doable with your current base.' },
          { role: 'user', content: 'Running has become a real part of my routine now. Three times a week, rain or shine. It helps so much with work stress.' },
          { role: 'assistant', content: 'That consistency is the real achievement — the race was just a milestone on a longer journey. Running as a stress management tool alongside cooking gives you great balance.' },
        ],
      },
    ],
  },

  // Day 27: Team celebration
  {
    day: 27,
    theme: 'Team celebration',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day27-s1',
        messages: [
          { role: 'user', content: 'Big day at work — Atlas hit 1000 active users! The team went out to celebrate at a nice sushi restaurant.' },
          { role: 'assistant', content: '1000 active users is a fantastic milestone for a data analytics platform! And celebrating at a sushi place sounds perfect for you. Was the whole team there?' },
          { role: 'user', content: 'Alice, Carol, and even Bob came back for the celebration. Our manager also announced that Atlas will be getting more engineering resources next quarter.' },
          { role: 'assistant', content: 'Nice that Bob joined the celebration — that shows strong team bonds. More resources means you can tackle the bigger architectural improvements like the Rust rewrite. Any idea what the expanded team will focus on?' },
          { role: 'user', content: 'We want to add real-time streaming analytics and a mobile dashboard. Carol is excited about the mobile work and Alice wants to lead the streaming infrastructure.' },
          { role: 'assistant', content: 'Real-time streaming and mobile are both high-impact features. Alice leading streaming infrastructure makes sense given her backend strengths, and Carol\'s visualization expertise will shine on mobile.' },
        ],
      },
    ],
  },

  // Day 28: Rust deep dive
  {
    day: 28,
    theme: 'Rust deep dive',
    expectedEmotion: 'neutral',
    sessions: [
      {
        id: 'day28-s1',
        messages: [
          { role: 'user', content: 'Made good progress with Rust this weekend. I\'m working through the concurrency chapter — channels and mutexes in Rust are so much safer than in most languages.' },
          { role: 'assistant', content: 'Rust\'s concurrency story is one of its strongest selling points. The ownership model makes data races impossible at compile time. How are you finding the learning curve?' },
          { role: 'user', content: 'The borrow checker still trips me up sometimes, but I\'m starting to think in terms of ownership naturally. I rewrote my CSV tool to use multi-threaded processing.' },
          { role: 'assistant', content: 'Thinking in ownership terms is the key breakthrough — once that clicks, the borrow checker becomes a helpful guide rather than an obstacle. Multi-threaded CSV processing is a great exercise for learning Rayon or tokio.' },
          { role: 'user', content: 'Used Rayon for data parallelism — got a 6x speedup on a 4-core machine. I\'m convinced now that the Atlas hot path rewrite in Rust is worth pursuing.' },
          { role: 'assistant', content: '6x speedup with Rayon\'s parallel iterators demonstrates the potential clearly. For the Atlas rewrite, you might want to prototype the most critical path first and benchmark it against the current implementation.' },
        ],
      },
    ],
  },

  // Day 29: Travel prep
  {
    day: 29,
    theme: 'Travel prep',
    expectedEmotion: 'happy',
    sessions: [
      {
        id: 'day29-s1',
        messages: [
          { role: 'user', content: 'Japan trip is in 2 weeks! I\'ve been studying basic Japanese phrases. Konnichiwa, arigatou, sumimasen — the essentials.' },
          { role: 'assistant', content: 'Learning basic phrases shows respect and goes a long way in Japan. \"Sumimasen\" is especially versatile — works for excuse me, sorry, and even thank you in casual contexts.' },
          { role: 'user', content: 'I also packed my camera gear and bought a pocket WiFi for the trip. The temple stay at Shunkoin is confirmed and I\'m so excited for the Zen meditation session.' },
          { role: 'assistant', content: 'Pocket WiFi is essential in Japan — Google Maps and translation apps will be your best friends. The Zen meditation at Shunkoin will be a unique experience. Have you looked into their specific schedule?' },
          { role: 'user', content: 'Yes, they do morning meditation at 6 AM followed by a garden tour. I also finalized my sushi-making class booking at Tsukiji for the second day in Tokyo.' },
          { role: 'assistant', content: 'Morning meditation followed by a garden tour at a Kyoto temple — that\'s going to be a memorable experience. And the Tsukiji sushi class on day 2 means you\'ll know what to look for when you visit sushi spots throughout the rest of the trip.' },
        ],
      },
    ],
  },

  // Day 30: Month-end retrospective
  {
    day: 30,
    theme: 'Month-end retrospective',
    expectedEmotion: 'content',
    sessions: [
      {
        id: 'day30-s1',
        messages: [
          { role: 'user', content: 'It\'s been a whole month! Looking back, so much has happened. What stands out to you from our conversations?' },
          { role: 'assistant', content: 'What a month! Atlas went from kickoff to 1000 users, you completed a 5K race in 31:14, started learning Rust with real results, and your Japan trip is almost here. Plus your cooking skills have expanded into Japanese cuisine and sourdough.' },
          { role: 'user', content: 'How has the Atlas team evolved over this month?' },
          { role: 'assistant', content: 'The team went through real growth — Alice stayed consistent and mentored Carol when Bob left for his promotion. Carol brought fresh energy with that 40% dashboard improvement. You navigated a memory leak, a race condition, and hit 1000 users.' },
          { role: 'user', content: 'What are all my current goals and upcoming plans?' },
          { role: 'assistant', content: 'You\'re training for a 10K in May after crushing the 5K, heading to Japan in 2 weeks for a temple stay and sushi class, planning to rewrite Atlas\'s hot path in Rust, and the team is expanding to add streaming analytics and a mobile dashboard.' },
        ],
      },
    ],
  },
];

/**
 * Get ground truth queries applicable for a given day.
 */
export function getQueriesForDay(day: number): GroundTruthQuery[] {
  return GROUND_TRUTH_QUERIES.filter(q => q.firstAnswerableDay <= day);
}
