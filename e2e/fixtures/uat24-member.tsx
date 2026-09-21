import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MemberDetailPage } from '../../src/pages/MemberDetailPage';
import '../../src/index.css';
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/organization/member/22222222-2222-4222-8222-222222222222?org_id=33333333-3333-4333-8333-333333333333']}><Routes><Route path="/organization/member/:memberId" element={<MemberDetailPage/>}/></Routes></MemoryRouter>);
