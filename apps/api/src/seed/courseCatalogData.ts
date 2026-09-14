// Kaizen Infinities' real training-course price list and its paid add-ons.
//
// Not demonstration data: this is the company's own catalogue, transcribed
// directly (byte-for-byte on the figures) from the price list Kaizen
// Infinities actually uses to raise course invoices. Every course carries
// its tenure-based monthly rate (a 1/3/6/8-month instalment plan — a course
// too short for the longer plans simply has no row for them), its contact
// hours, its SAC code and the pricing rationale it was built from. Add-ons
// are optional extras sold alongside a specific course (mainly certification
// exam fees), priced as one fixed total rather than a monthly rate.
//
// This module only holds the data; seedCourseCatalog() in this same
// directory is what writes it to a tenant, and it is invoked as its own
// deliberate step (pnpm --filter @kaizen/api run seed:course-catalog) —
// never from the ordinary pnpm seed bootstrap that every fresh tenant
// runs, so an install for a different company still starts with an empty
// catalogue.

export interface CourseCatalogEntry {
  name: string;
  /** Monthly rate on a 1-month plan. Null where the course is not sold that way. */
  m1: number | null;
  m3: number | null;
  m6: number | null;
  m8: number | null;
  /** GST rate as a percentage (18, not 0.18). */
  gstRate: number;
  sac: string;
  hours: number;
  notes: string;
}

export interface CourseAddonEntry {
  /** The course this add-on is sold alongside — matched by name against CourseCatalogEntry.name. */
  course: string;
  name: string;
  price: number;
  gstRate: number;
  sac: string;
  notes: string;
}

export const COURSE_CATALOG: CourseCatalogEntry[] = [
  { name: "SAP HRMS (HR and Administrator) — Student Track", m1: 52500, m3: 21000, m6: 12600, m8: 10395, gstRate: 18, sac: "9983", hours: 150, notes: "SAP training, student track. Rs.350/hr x 150hrs = Rs.52,500 base total, cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.52,500); 3/6/8-month are instalment plans." },
  { name: "SAP HRMS (HR and Administrator) — Working Professional Track", m1: 32999, m3: 13199.6, m6: 7919.76, m8: 6533.8, gstRate: 18, sac: "9983", hours: 90, notes: "SAP training, working professional track. Base price set directly at Rs.32,999 (pre-tax, working-professional rate), cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.32,999); 3/6/8-month are instalment plans." },
  { name: "SAP MM (Material Management) — Student Track", m1: 52500, m3: 21000, m6: 12600, m8: 10395, gstRate: 18, sac: "9983", hours: 150, notes: "SAP training, student track. Rs.350/hr x 150hrs = Rs.52,500 base total, cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.52,500); 3/6/8-month are instalment plans." },
  { name: "SAP MM (Material Management) — Working Professional Track", m1: 32999, m3: 13199.6, m6: 7919.76, m8: 6533.8, gstRate: 18, sac: "9983", hours: 90, notes: "SAP training, working professional track. Base price set directly at Rs.32,999 (pre-tax, working-professional rate), cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.32,999); 3/6/8-month are instalment plans." },
  { name: "SAP SD (Sales and Distribution) — Student Track", m1: 52500, m3: 21000, m6: 12600, m8: 10395, gstRate: 18, sac: "9983", hours: 150, notes: "SAP training, student track. Rs.350/hr x 150hrs = Rs.52,500 base total, cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.52,500); 3/6/8-month are instalment plans." },
  { name: "SAP SD (Sales and Distribution) — Working Professional Track", m1: 32999, m3: 13199.6, m6: 7919.76, m8: 6533.8, gstRate: 18, sac: "9983", hours: 90, notes: "SAP training, working professional track. Base price set directly at Rs.32,999 (pre-tax, working-professional rate), cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.32,999); 3/6/8-month are instalment plans." },
  { name: "SAP FICO (Financial Accounting and Control) — Student Track", m1: 52500, m3: 21000, m6: 12600, m8: 10395, gstRate: 18, sac: "9983", hours: 150, notes: "SAP training, student track. Rs.350/hr x 150hrs = Rs.52,500 base total, cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.52,500); 3/6/8-month are instalment plans." },
  { name: "SAP FICO (Financial Accounting and Control) — Working Professional Track", m1: 32999, m3: 13199.6, m6: 7919.76, m8: 6533.8, gstRate: 18, sac: "9983", hours: 90, notes: "SAP training, working professional track. Base price set directly at Rs.32,999 (pre-tax, working-professional rate), cascaded 20%/20%/10% same as other courses. 1-month = single lump-sum payment (same Rs.32,999); 3/6/8-month are instalment plans." },
  { name: ".NET Development", m1: 15000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 100, notes: "Rs.150/hr (Mixed) x 100hrs = Rs.15,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "AI Agents & Automation", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "AI Content Creation", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.180/hr (Practical) x 35hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Artificial Intelligence & Data Science (Advanced Master Program)", m1: 73500, m3: 29400, m6: 17640, m8: null, gstRate: 18, sac: "9983", hours: 350, notes: "Rs.210/hr (High-value) x 350hrs = Rs.73,500 (1-mo total)" },
  { name: "AI Image Generation", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.180/hr (Practical) x 25hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "AI Presentation Design", m1: 3600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 20, notes: "Rs.180/hr (Practical) x 20hrs = Rs.3,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "AI Video Editing", m1: 5400, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.180/hr (Practical) x 30hrs = Rs.5,400 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "AI-Powered Marketing", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Adobe Illustrator", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.180/hr (Practical) x 35hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Adobe Photoshop", m1: 7200, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.180/hr (Practical) x 40hrs = Rs.7,200 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Advanced Digital Marketing with AI Tools", m1: 14700, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.210/hr (High-value) x 70hrs = Rs.14,700 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Advanced Digital Marketing", m1: 12000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 80, notes: "Rs.150/hr (Mixed) x 80hrs = Rs.12,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Advanced Generative AI", m1: 73500, m3: 29400, m6: 17640, m8: null, gstRate: 18, sac: "9983", hours: 350, notes: "Rs.210/hr (High-value) x 350hrs = Rs.73,500 (1-mo total)" },
  { name: "Airtable Automation", m1: 3600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 20, notes: "Rs.180/hr (Practical) x 20hrs = Rs.3,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Amazon Web Services (AWS)", m1: 14700, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.210/hr (High-value) x 70hrs = Rs.14,700 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Automation Anywhere", m1: 7200, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.180/hr (Practical) x 40hrs = Rs.7,200 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Backend APIs", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.150/hr (Mixed) x 60hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Bug Bounty Hunting", m1: 9450, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.210/hr (High-value) x 45hrs = Rs.9,450 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Business Analytics", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "C & C++", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.180/hr (Practical) x 70hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "CCNA", m1: 12000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 80, notes: "Rs.150/hr (Mixed) x 80hrs = Rs.12,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "CCNP", m1: 15000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 100, notes: "Rs.150/hr (Mixed) x 100hrs = Rs.15,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "CI-CD Pipelines", m1: 7350, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.210/hr (High-value) x 35hrs = Rs.7,350 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Canva Pro", m1: 3600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 20, notes: "Rs.180/hr (Practical) x 20hrs = Rs.3,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Cloud Computing & DevOps (Advanced Master Program)", m1: 63000, m3: 25200, m6: 15120, m8: null, gstRate: 18, sac: "9983", hours: 300, notes: "Rs.210/hr (High-value) x 300hrs = Rs.63,000 (1-mo total)" },
  { name: "Cloud Security", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Computer Vision", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Content Marketing", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Data Analytics & Business Intelligence (Advanced Master Program)", m1: 71400, m3: 28560, m6: 17136, m8: null, gstRate: 18, sac: "9983", hours: 340, notes: "Rs.210/hr (High-value) x 340hrs = Rs.71,400 (1-mo total)" },
  { name: "Data Analytics with PowerBI & Tableau", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Data Science with Python", m1: 14700, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.210/hr (High-value) x 70hrs = Rs.14,700 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Data Visualization", m1: 3750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.150/hr (Mixed) x 25hrs = Rs.3,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Deep Learning", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "DevSecOps", m1: 5250, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.210/hr (High-value) x 25hrs = Rs.5,250 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Digital Forensics", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Docker", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.210/hr (High-value) x 30hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "E-Commerce Marketing", m1: 6750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.150/hr (Mixed) x 45hrs = Rs.6,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Email Marketing", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.150/hr (Mixed) x 30hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Ethical Hacking", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Figma", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.180/hr (Practical) x 35hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Financial Analytics", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Firebase", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.150/hr (Mixed) x 30hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Full Stack - Java", m1: 21000, m3: 8400, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 140, notes: "Rs.150/hr (Mixed) x 140hrs = Rs.21,000 (1-mo total)" },
  { name: "Full Stack - MERN (Web Development)", m1: 18000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 120, notes: "Rs.150/hr (Mixed) x 120hrs = Rs.18,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Full Stack - Python", m1: 18000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 120, notes: "Rs.150/hr (Mixed) x 120hrs = Rs.18,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "GO (Golang)", m1: 7200, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.180/hr (Practical) x 40hrs = Rs.7,200 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Generative AI (Beg-Adv)", m1: 16800, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 80, notes: "Rs.210/hr (High-value) x 80hrs = Rs.16,800 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Git & Github", m1: 5250, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.210/hr (High-value) x 25hrs = Rs.5,250 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Google Cloud Platform (GCP)", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Graphic Design", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.180/hr (Practical) x 50hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Internet of Things (IoT) (Advanced Master Program)", m1: 73500, m3: 29400, m6: 17640, m8: null, gstRate: 18, sac: "9983", hours: 350, notes: "Rs.210/hr (High-value) x 350hrs = Rs.73,500 (1-mo total)" },
  { name: "Java", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.180/hr (Practical) x 70hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Javascript", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.180/hr (Practical) x 50hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Jenkins", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.210/hr (High-value) x 30hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Kubernetes", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Linux Administration", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.150/hr (Mixed) x 60hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "MAKE", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.180/hr (Practical) x 25hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "MLOPS", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "MONGODB", m1: 5250, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.150/hr (Mixed) x 35hrs = Rs.5,250 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Machine Learning", m1: 14700, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.210/hr (High-value) x 70hrs = Rs.14,700 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Malware Analysis", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Marketing Automation", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Microservices", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.150/hr (Mixed) x 60hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Microsoft Azure", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Microsoft Excel Advanced", m1: 5250, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.150/hr (Mixed) x 35hrs = Rs.5,250 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Microsoft Power Platform", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.180/hr (Practical) x 50hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Mobile App Development", m1: 15000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 100, notes: "Rs.150/hr (Mixed) x 100hrs = Rs.15,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Mobile Security", m1: 9450, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.210/hr (High-value) x 45hrs = Rs.9,450 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Motion Graphics", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.180/hr (Practical) x 50hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "MySQL", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "N8N", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.180/hr (Practical) x 25hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Natural Language Processing", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Network Security", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Oracle Database", m1: 7500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.150/hr (Mixed) x 50hrs = Rs.7,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "PHP", m1: 8100, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.180/hr (Practical) x 45hrs = Rs.8,100 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Penetration Testing", m1: 14700, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.210/hr (High-value) x 70hrs = Rs.14,700 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Performance Marketing", m1: 7500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.150/hr (Mixed) x 50hrs = Rs.7,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Personal Branding", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.180/hr (Practical) x 25hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Podcast Production with AI", m1: 4500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.180/hr (Practical) x 25hrs = Rs.4,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "PostgreSQL", m1: 6750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.150/hr (Mixed) x 45hrs = Rs.6,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "PowerBI", m1: 6750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.150/hr (Mixed) x 45hrs = Rs.6,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Prompt Engineering", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.210/hr (High-value) x 30hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Python", m1: 10800, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.180/hr (Practical) x 60hrs = Rs.10,800 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Redis", m1: 3750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 25, notes: "Rs.150/hr (Mixed) x 25hrs = Rs.3,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Rust", m1: 8100, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.180/hr (Practical) x 45hrs = Rs.8,100 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "SEO & SEM", m1: 7500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.150/hr (Mixed) x 50hrs = Rs.7,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "SOC Analyst", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "SQL", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Security +", m1: 12600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 60, notes: "Rs.210/hr (High-value) x 60hrs = Rs.12,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Social Media Marketing", m1: 6750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.150/hr (Mixed) x 45hrs = Rs.6,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Software Testing & QA", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 70, notes: "Rs.150/hr (Mixed) x 70hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Storage and Backup Solutions", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Tableau", m1: 6000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 40, notes: "Rs.150/hr (Mixed) x 40hrs = Rs.6,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Terraform", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.210/hr (High-value) x 30hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Typescript", m1: 6300, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 35, notes: "Rs.180/hr (Practical) x 35hrs = Rs.6,300 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "UI-UX Design", m1: 14400, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 80, notes: "Rs.180/hr (Practical) x 80hrs = Rs.14,400 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "UIPATH (RPA)", m1: 9000, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.180/hr (Practical) x 50hrs = Rs.9,000 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Video Editing", m1: 8100, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.180/hr (Practical) x 45hrs = Rs.8,100 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Virtualization (VMware & HyperV)", m1: 6750, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 45, notes: "Rs.150/hr (Mixed) x 45hrs = Rs.6,750 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Web Application Security", m1: 10500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.210/hr (High-value) x 50hrs = Rs.10,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Windows Server Administration", m1: 7500, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 50, notes: "Rs.150/hr (Mixed) x 50hrs = Rs.7,500 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Youtube Content Creation", m1: 5400, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 30, notes: "Rs.180/hr (Practical) x 30hrs = Rs.5,400 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
  { name: "Zapier", m1: 3600, m3: null, m6: null, m8: null, gstRate: 18, sac: "9983", hours: 20, notes: "Rs.180/hr (Practical) x 20hrs = Rs.3,600 (1-mo total) / 1-month slab only — course too short for longer instalment plans" },
];

export const COURSE_ADDONS: CourseAddonEntry[] = [
  { course: "SAP HRMS (HR and Administrator) — Student Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP HRMS (HR and Administrator) — Working Professional Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP MM (Material Management) — Student Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP MM (Material Management) — Working Professional Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP SD (Sales and Distribution) — Student Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP SD (Sales and Distribution) — Working Professional Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP FICO (Financial Accounting and Control) — Student Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "SAP FICO (Financial Accounting and Control) — Working Professional Track", name: "Official SAP Certification Exam", price: 60000, gstRate: 18, sac: "9983", notes: "Optional — paid directly to SAP, not bundled into Kaizen's training fee" },
  { course: "Amazon Web Services (AWS)", name: "AWS Certification Exam Prep", price: 10000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.9,800-30,300 (USD 100-300 depending on level), paid to AWS separately" },
  { course: "Microsoft Azure", name: "Azure Certification Exam Prep", price: 8000, gstRate: 18, sac: "9983", notes: "Exam Rs.3,696-4,865 (AZ-900/AZ-104/AZ-400), paid to Microsoft separately" },
  { course: "Google Cloud Platform (GCP)", name: "GCP Certification Exam Prep", price: 8000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.10,400-16,600 (USD 125-200), paid to Google separately" },
  { course: "CCNA", name: "CCNA Certification Exam Prep", price: 12000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.22,000-27,000 (USD 300), paid to Cisco/Pearson VUE separately" },
  { course: "CCNP", name: "CCNP Certification Exam Prep", price: 18000, gstRate: 18, sac: "9983", notes: "Two exams ~Rs.58,000-60,000 total (USD 700), paid to Cisco/Pearson VUE separately" },
  { course: "Security +", name: "CompTIA Security+ Certification Exam Prep", price: 10000, gstRate: 18, sac: "9983", notes: "Exam voucher ~Rs.29,000, paid to CompTIA separately" },
  { course: "Penetration Testing", name: "CompTIA PenTest+ Certification Exam Prep", price: 14000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.28,900, paid to CompTIA separately" },
  { course: "SOC Analyst", name: "CompTIA CySA+ Certification Exam Prep", price: 14000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.28,900, paid to CompTIA separately" },
  { course: "Oracle Database", name: "Oracle Certification Exam Prep", price: 12000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.18,000-21,000 (USD 245), paid to Oracle separately" },
  { course: "Software Testing & QA", name: "ISTQB Certification Exam Prep", price: 6000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.5,700-6,850, paid to ISTQB/Indian Testing Board separately" },
  { course: "PowerBI", name: "Microsoft PL-300 Certification Exam Prep", price: 5000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.4,800, paid to Microsoft separately" },
  { course: "Tableau", name: "Tableau Certification Exam Prep", price: 6000, gstRate: 18, sac: "9983", notes: "Exam ~Rs.8,300-8,700 (USD 100); verify current fee/name, paid to Salesforce/Tableau separately" },
];
