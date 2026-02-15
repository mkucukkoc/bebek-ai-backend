import { db } from '../../../firebase';
import { calculateDailyTargets, DailyTargets, UserInfo } from './userInfoService';

export interface DailyStats {
  id: string;
  user_id: string;
  date: string;
  calories_goal: number;
  calories_consumed: number;
  protein_goal_g: number;
  protein_consumed_g: number;
  carbs_goal_g: number;
  carbs_consumed_g: number;
  fat_goal_g: number;
  fat_consumed_g: number;
  water_ml: number;
  steps: number;
}

export const getOrCreateDailyStats = async (user: UserInfo, date: string) => {
  const snapshot = await db
    .collection('daily_stats')
    .where('user_id', '==', user.id)
    .where('date', '==', date)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    const doc = snapshot.docs[0];
    const data = doc.data() as DailyStats;
    return { ...data, id: doc.id };
  }

  const targets: DailyTargets = calculateDailyTargets(user);
  const stats: DailyStats = {
    id: '',
    user_id: user.id,
    date,
    calories_goal: targets.calories_goal,
    calories_consumed: 0,
    protein_goal_g: targets.protein_goal_g,
    protein_consumed_g: 0,
    carbs_goal_g: targets.carbs_goal_g,
    carbs_consumed_g: 0,
    fat_goal_g: targets.fat_goal_g,
    fat_consumed_g: 0,
    water_ml: 0,
    steps: 0
  };

  const ref = await db.collection('daily_stats').add(stats);
  return { ...stats, id: ref.id };
};
