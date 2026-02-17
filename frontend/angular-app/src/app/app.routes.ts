import { Routes } from '@angular/router';
import { TieraiDashboardComponent } from './components/tierai-dashboard/tierai-dashboard.component';

export const routes: Routes = [
  { path: '', redirectTo: 'tierai', pathMatch: 'full' },
  { path: 'tierai', component: TieraiDashboardComponent },
];
