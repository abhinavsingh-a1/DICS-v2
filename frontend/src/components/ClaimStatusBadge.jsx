import React from 'react';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
};

export default function ClaimStatusBadge({ status }) {
  return <span className="status">{STATUS_LABELS[status] || status}</span>;
}
