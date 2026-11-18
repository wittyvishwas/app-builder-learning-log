<?php
declare(strict_types=1);

namespace MageMinion\OrderExport\Cron;

use MageMinion\OrderExport\Model\Retry as RetryTable;
use MageMinion\OrderExport\Model\Sender;
use Psr\Log\LoggerInterface;

/**
 * Every 10 minutes: resend pending rows. 6 sends in total (the first one was in the observer), then the row is dead.
 */
class Retry
{
    private const MAX_ATTEMPTS = 6;

    /**
     * @param Sender $sender
     * @param RetryTable $retry
     * @param LoggerInterface $logger
     */
    public function __construct(
        private readonly Sender $sender,
        private readonly RetryTable $retry,
        private readonly LoggerInterface $logger
    ) {
    }

    /**
     * Resend the pending rows.
     *
     * @return void
     */
    public function execute(): void
    {
        try {
            if (!$this->sender->isEnabled()) {
                return;
            }
            foreach ($this->retry->due() as $row) {
                $id = (int)$row['entity_id'];
                $attempts = (int)$row['attempts'] + 1;
                // The observer runs before the order is saved. If that save failed, there is no order: never send it.
                // A row younger than 5 minutes may belong to an order whose save hasn't committed yet: wait.
                if (!$this->retry->orderExists($row['increment_id'])) {
                    if ((int)$row['is_recent'] === 1) {
                        continue;
                    }
                    $this->retry->mark($id, (int)$row['attempts'], 'dead', 'order was never saved');
                    continue;
                }
                try {
                    $this->sender->post($row['increment_id'], $row['payload']);
                    $this->retry->mark($id, $attempts, 'sent', null);
                } catch (\Throwable $e) {
                    $status = $attempts >= self::MAX_ATTEMPTS ? 'dead' : 'pending';
                    $this->retry->mark($id, $attempts, $status, $e->getMessage());
                }
            }
        } catch (\Throwable $e) {
            try {
                $this->logger->error('retry run failed: ' . $e->getMessage());
            } catch (\Throwable) {
                // Nothing left to do: the next run tries again.
            }
        }
    }
}
